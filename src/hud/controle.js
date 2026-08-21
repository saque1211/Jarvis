import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, ensureDirs } from '../core/config.js';
import { lerSettings, gravarSettings } from '../core/settings.js';
import {
  concluir,
  listar as listarAvisos,
  criar as criarAviso,
  remover as removerAviso,
  pendentes as pendentesDeAviso,
} from '../core/avisos.js';
import { listarCompras, adicionar, marcar, remover as removerCompra } from '../skills/compras.js';
import * as plataforma from '../platform/index.js';

/**
 * Central de controle e fotos — o que o mockup 3 desenha e o app do celular
 * edita de longe.
 *
 * Fora do server.js porque sao coisas diferentes: la e transporte (SSE, estado,
 * uma pagina), aqui e comando (mexe na maquina, grava arquivo). Misturar as
 * duas faria o arquivo de transporte crescer toda vez que a tela ganhasse um
 * botao novo.
 */

// Foto de fundo de tela cheia. 12 MB cobre um JPEG de celular moderno com
// folga; sem teto, um POST torto enche a memoria do Raspberry.
const LIMITE_FOTO = 12 * 1024 * 1024;
const LIMITE_JSON = 256 * 1024;

// As rotas que mexem em alguma coisa e por isso passam pelo token.
const CONTROLE = new Set([
  '/config',
  '/wifi',
  '/brilho',
  '/volume',
  '/sistema/reiniciar',
  '/sistema/resetar',
]);

const TIPOS = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

function pastaDeFotos() {
  ensureDirs();
  const dir = path.join(config.vaultPath, 'fotos');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function lerCorpo(req, limite) {
  return new Promise((resolve, reject) => {
    const partes = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > limite) {
        // Destroi a conexao em vez de so parar de ler: continuar recebendo
        // bytes que serao jogados fora e exatamente o que trava a maquina.
        req.destroy();
        reject(new Error(`Arquivo grande demais (limite ${Math.round(limite / 1024 / 1024)} MB).`));
        return;
      }
      partes.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(partes)));
    req.on('error', reject);
  });
}

async function lerJson(req) {
  const bruto = await lerCorpo(req, LIMITE_JSON);
  if (!bruto.length) return {};
  try {
    return JSON.parse(bruto.toString('utf8'));
  } catch {
    throw new Error('Corpo nao e JSON valido.');
  }
}

function responder(res, status, dados) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(dados));
}

/**
 * Quem pode mandar.
 *
 * O HUD escuta em 0.0.0.0 porque a graca e abrir no celular pelo IP da rede.
 * Isso significa que qualquer aparelho do Wi-Fi alcanca estas rotas — e agora
 * elas reiniciam a maquina e trocam a senha do Wi-Fi. Com VEXIS_HUD_TOKEN no
 * .env, tudo que MUDA alguma coisa passa a exigir o token; sem ele, segue
 * aberto na rede local, que era o comportamento de antes.
 */
export function autorizado(req) {
  const token = process.env.VEXIS_HUD_TOKEN || process.env.JARVIS_HUD_TOKEN;
  if (!token) return true;

  const enviado = req.headers['x-vexis-token'];
  if (!enviado) return false;

  // Comparacao de tempo constante: `===` em segredo vaza o tamanho do prefixo
  // certo pra quem mede o tempo de resposta.
  const a = Buffer.from(String(enviado));
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function listarFotos() {
  try {
    return fs
      .readdirSync(pastaDeFotos())
      .filter((f) => /\.(jpg|png|webp)$/i.test(f))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Trata as rotas de controle. Devolve true quando atendeu — o server.js segue
 * pro 404 dele quando isto devolve false.
 */
export async function atenderControle(req, res, url) {
  const rota = url.pathname;
  const mudaAlgo = req.method !== 'GET';

  if (rota.startsWith('/fotos') || CONTROLE.has(rota) || rota.startsWith('/aviso') || rota.startsWith('/compras')) {
    if (mudaAlgo && !autorizado(req)) {
      responder(res, 401, { erro: 'Token invalido ou ausente (cabecalho x-vexis-token).' });
      return true;
    }
  }

  // ---- FOTOS DE FUNDO ------------------------------------------------------

  if (rota === '/fotos' && req.method === 'GET') {
    responder(res, 200, { fotos: listarFotos() });
    return true;
  }

  if (rota === '/fotos' && req.method === 'POST') {
    const tipo = String(req.headers['content-type'] || '').split(';')[0].trim();
    const ext = TIPOS[tipo];
    if (!ext) {
      responder(res, 415, { erro: `Formato ${tipo || 'desconhecido'} nao aceito. Use JPEG, PNG ou WebP.` });
      return true;
    }

    const bytes = await lerCorpo(req, LIMITE_FOTO);
    if (!bytes.length) {
      responder(res, 400, { erro: 'Arquivo vazio.' });
      return true;
    }

    const nome = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
    fs.writeFileSync(path.join(pastaDeFotos(), nome), bytes);

    // Ja entra no rodizio: enviar uma foto e nao ve-la aparecer parece que
    // falhou, e a pessoa manda de novo.
    const s = lerSettings();
    gravarSettings({ aparencia: { fotos: [...s.aparencia.fotos, nome] } });

    responder(res, 200, { ok: true, foto: nome, total: listarFotos().length });
    return true;
  }

  const umaFoto = /^\/fotos\/([\w.-]+)$/.exec(rota);
  if (umaFoto) {
    // Nome vem da URL: sem esta checagem, "..%2f..%2fetc%2fpasswd" leria o que
    // quisesse. A regex ja barra `/`, e o basename fecha o resto.
    const nome = path.basename(umaFoto[1]);
    const arquivo = path.join(pastaDeFotos(), nome);

    if (req.method === 'DELETE') {
      fs.rmSync(arquivo, { force: true });
      const s = lerSettings();
      gravarSettings({ aparencia: { fotos: s.aparencia.fotos.filter((f) => f !== nome) } });
      responder(res, 200, { ok: true });
      return true;
    }

    if (req.method === 'GET') {
      if (!fs.existsSync(arquivo)) {
        responder(res, 404, { erro: 'Foto nao encontrada.' });
        return true;
      }
      const ext = path.extname(nome).slice(1).toLowerCase();
      res.writeHead(200, {
        'content-type': ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg',
        // O nome ja carrega timestamp e aleatorio, entao o conteudo nunca muda
        // pro mesmo nome — cache longo evita reler o disco a cada rodizio.
        'cache-control': 'public, max-age=604800, immutable',
      });
      fs.createReadStream(arquivo).pipe(res);
      return true;
    }
  }

  // ---- PREFERENCIAS --------------------------------------------------------

  if (rota === '/config' && req.method === 'GET') {
    const s = lerSettings();
    // O token do Home Assistant nao sai daqui — veja preferenciasDoHud().
    responder(res, 200, { ...s, casa: { ...s.casa, token: s.casa.token ? '(guardado)' : null } });
    return true;
  }

  if (rota === '/config' && req.method === 'POST') {
    const patch = await lerJson(req);
    // "(guardado)" e o que o GET devolve no lugar do token. Se voltar assim no
    // POST, e porque a tela so devolveu o que recebeu — nao e uma troca.
    if (patch.casa?.token === '(guardado)') delete patch.casa.token;
    responder(res, 200, { ok: true, config: gravarSettings(patch) });
    return true;
  }

  // ---- REDE ----------------------------------------------------------------

  if (rota === '/wifi' && req.method === 'GET') {
    try {
      responder(res, 200, { redes: await plataforma.listarRedes() });
    } catch (err) {
      responder(res, 200, { redes: [], erro: err.message });
    }
    return true;
  }

  if (rota === '/wifi' && req.method === 'POST') {
    const { ssid, senha } = await lerJson(req);
    try {
      responder(res, 200, await plataforma.conectarRede(ssid, senha));
    } catch (err) {
      responder(res, 200, { ok: false, erro: err.message });
    }
    return true;
  }

  // ---- BRILHO E VOLUME -----------------------------------------------------

  if (rota === '/brilho' && req.method === 'POST') {
    const { nivel } = await lerJson(req);
    try {
      const r = await plataforma.definirBrilho(nivel);
      // Guarda tambem: no Windows a leitura nem sempre existe, e o controle
      // deslizante precisa voltar na posicao certa quando a tela recarregar.
      gravarSettings({ brilho: { nivel: r.nivel, auto: false } });
      responder(res, 200, r);
    } catch (err) {
      responder(res, 200, { ok: false, erro: err.message });
    }
    return true;
  }

  if (rota === '/volume' && req.method === 'POST') {
    const { nivel } = await lerJson(req);
    const anterior = lerSettings().volume.nivel;
    try {
      const r = await plataforma.definirVolume(nivel, anterior);
      gravarSettings({ volume: { nivel: r.nivel } });
      responder(res, 200, r);
    } catch (err) {
      responder(res, 200, { ok: false, erro: err.message });
    }
    return true;
  }

  // ---- SISTEMA -------------------------------------------------------------

  if (rota === '/sistema/reiniciar' && req.method === 'POST') {
    try {
      responder(res, 200, await plataforma.reiniciarDispositivo());
    } catch (err) {
      responder(res, 200, { ok: false, erro: err.message });
    }
    return true;
  }

  if (rota === '/sistema/resetar' && req.method === 'POST') {
    const { confirmado } = await lerJson(req);
    // Mesma regra das tools destrutivas: sem `confirmado`, devolve o pedido de
    // confirmacao em vez de executar.
    if (!confirmado) {
      responder(res, 200, {
        ok: false,
        confirmar: 'Isto apaga fotos, avisos, lista de compras e preferencias. Confirma?',
      });
      return true;
    }
    const { padroesDeSettings } = await import('../core/settings.js');
    gravarSettings(padroesDeSettings());
    for (const foto of listarFotos()) fs.rmSync(path.join(pastaDeFotos(), foto), { force: true });
    responder(res, 200, { ok: true });
    return true;
  }

  // ---- AVISOS E COMPRAS ----------------------------------------------------

  if (rota === '/avisos' && req.method === 'GET') {
    // Todos, nao so os pendentes: a tela do celular edita a REGRA ("toda
    // quinta, das 8 as 21"), e o HUD e que mostra o que esta pendente agora.
    responder(res, 200, { avisos: listarAvisos(), pendentes: pendentesDeAviso() });
    return true;
  }

  if (rota === '/avisos' && req.method === 'POST') {
    const { texto, dias, de, ate } = await lerJson(req);
    try {
      responder(res, 200, { ok: true, aviso: criarAviso({ texto, dias, de, ate }) });
    } catch (err) {
      responder(res, 400, { ok: false, erro: err.message });
    }
    return true;
  }

  const avisoId = /^\/avisos\/(\d+)$/.exec(rota);
  if (avisoId && req.method === 'DELETE') {
    const r = removerAviso(Number(avisoId[1]));
    responder(res, r ? 200 : 404, r ? { ok: true } : { erro: 'Aviso nao encontrado.' });
    return true;
  }

  const avisoFeito = /^\/aviso\/(\d+)\/feito$/.exec(rota);
  if (avisoFeito && req.method === 'POST') {
    const r = concluir(Number(avisoFeito[1]));
    responder(res, r ? 200 : 404, r ? { ok: true, aviso: r } : { erro: 'Aviso nao encontrado.' });
    return true;
  }

  if (rota === '/compras' && req.method === 'GET') {
    responder(res, 200, { itens: listarCompras() });
    return true;
  }

  if (rota === '/compras' && req.method === 'POST') {
    const { itens } = await lerJson(req);
    responder(res, 200, { ok: true, novos: adicionar(itens), itens: listarCompras() });
    return true;
  }

  if (rota === '/compras' && req.method === 'PATCH') {
    const { item, feito } = await lerJson(req);
    const r = marcar(item, feito !== false);
    responder(res, 200, { ok: Boolean(r), itens: listarCompras() });
    return true;
  }

  if (rota === '/compras' && req.method === 'DELETE') {
    const { item } = await lerJson(req);
    const r = removerCompra(item);
    responder(res, 200, { ok: Boolean(r), itens: listarCompras() });
    return true;
  }

  return false;
}
