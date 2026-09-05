import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshot } from '../core/state.js';
import { route } from '../core/router.js';
import { previsao, deveMostrar } from '../skills/weather.js';
import { capacidades } from '../platform/index.js';
import { atenderControle } from '../hud/controle.js';
import {
  registrar,
  entrar,
  usuarioDoToken,
  pedirCodigo,
  aprovarCodigo,
  conferirCodigo,
  aparelhoValido,
  aparelhoDoToken,
  aparelhosDe,
  removerAparelho,
} from './contas.js';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const HUD = path.join(AQUI, '..', 'hud');
const APP = path.join(AQUI, '..', 'app');

/**
 * Nucleus — a porta de entrada com contas.
 *
 * O HUD local (porta 8791) e aberto: quem esta na sua rede ja esta dentro de
 * casa. O nucleus e o oposto — mora na internet, entao TODA rota de dado exige
 * login. Ele serve as MESMAS paginas (HUD e app), delega o cerebro pro mesmo
 * router, e por cima poe a camada que faltava: entrar, criar conta, e parear
 * um aparelho a uma pessoa.
 *
 * A pagina decide sozinha: sem token no `location.port===3000`, o HUD manda a
 * pessoa pro /app pra entrar. Aqui a gente so guarda o portao.
 */

// Cerebro de voz. O /voz do HUD chega aqui; o nucleus repassa pro servidor de
// voz com o token guardado do lado dele — o navegador nunca ve esse token.
const VOZ_URL = (process.env.JARVIS_CLOUD_URL || '').replace(/\/$/, '');
const VOZ_TOKEN = process.env.JARVIS_CLOUD_TOKEN || '';

function json(res, status, corpo) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(corpo));
}

function servirArquivo(res, arquivo, tipo, cache) {
  try {
    const conteudo = fs.readFileSync(arquivo);
    res.writeHead(200, { 'content-type': tipo, 'cache-control': cache || 'no-cache' });
    res.end(conteudo);
  } catch {
    json(res, 404, { erro: 'nao encontrado' });
  }
}

function lerCorpo(req, limite = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const pedacos = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > limite) {
        reject(Object.assign(new Error('corpo grande demais'), { limite: true }));
        req.destroy();
        return;
      }
      pedacos.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(pedacos)));
    req.on('error', reject);
  });
}

/** Token vem no Bearer ou, pro SSE que nao manda cabecalho, no ?token=. */
function tokenDaReq(req, url) {
  const auth = (req.headers.authorization || '').replace(/^Bearer /i, '').trim();
  return auth || url.searchParams.get('token') || '';
}

function quemE(req, url) {
  return usuarioDoToken(tokenDaReq(req, url));
}

/**
 * Quem esta agindo: uma pessoa (JWT) ou um aparelho pareado (token de aparelho,
 * no x-device-token ou ?device=). Um painel de parede age sem senha em nome de
 * quem o aprovou; email e senha ficam so pro app, onde ha teclado.
 */
function ator(req, url) {
  const bearer = tokenDaReq(req, url);
  const pessoa = usuarioDoToken(bearer);
  if (pessoa) return { tipo: 'pessoa', user: pessoa };
  const dt = req.headers['x-device-token'] || url.searchParams.get('device') || bearer;
  const aparelho = aparelhoDoToken(dt);
  if (aparelho) return { tipo: 'aparelho', device: aparelho };
  return null;
}

export function startNucleus({ port = 3000, host = '0.0.0.0' } = {}) {
  const clientes = new Set();
  // Presenca dos paineis: id do aparelho -> quantas conexoes de estado abertas.
  // Um painel ligado mantem o SSE aberto; caiu a zero, esta desligado. E o que
  // deixa a Casa do app dizer "ligado" sem inventar.
  const presenca = new Map();
  const marcarPresenca = (id, delta) => {
    const n = (presenca.get(id) || 0) + delta;
    if (n > 0) presenca.set(id, n); else presenca.delete(id);
  };
  let vitais = null;
  let tempo = null;
  let caps = null;

  const servidor = http.createServer(async (req, res) => {
    try {
      await atender(req, res);
    } catch (err) {
      console.error(`[nucleus] ${req.method} ${req.url}: ${err.message}`);
      if (!res.headersSent) json(res, 500, { erro: err.message });
      else res.end();
    }
  });

  async function atender(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    // ── Paginas e assets: abertos. A propria pagina exige login por dentro. ──
    if (p === '/') return servirArquivo(res, path.join(HUD, 'index.html'), 'text/html; charset=utf-8');
    if (p === '/app' || p === '/app/') return servirArquivo(res, path.join(APP, 'index.html'), 'text/html; charset=utf-8');
    const asset = /^\/app\/(manifest\.json|sw\.js|icone(?:-mascara)?\.png)$/.exec(p);
    if (asset) {
      const tipo = asset[1].endsWith('.json') ? 'application/manifest+json'
        : asset[1].endsWith('.js') ? 'text/javascript' : 'image/png';
      return servirArquivo(res, path.join(APP, asset[1]),
        `${tipo}; charset=utf-8`, asset[1] === 'sw.js' ? 'no-cache' : 'public, max-age=86400');
    }

    // ── Contas: entrar e criar sao abertas (sao o proprio portao). ──────────
    if (p === '/auth/register' && req.method === 'POST') {
      try {
        const { email, password } = JSON.parse((await lerCorpo(req)).toString() || '{}');
        return json(res, 200, registrar(email, password));
      } catch (err) {
        return json(res, 400, { erro: err.message });
      }
    }
    if (p === '/auth/login' && req.method === 'POST') {
      try {
        const { email, password } = JSON.parse((await lerCorpo(req)).toString() || '{}');
        return json(res, 200, entrar(email, password));
      } catch (err) {
        return json(res, 400, { erro: err.message });
      }
    }
    if (p === '/auth/profile') {
      const u = quemE(req, url);
      return u ? json(res, 200, { user: u }) : json(res, 401, { erro: 'token invalido ou ausente' });
    }

    // ── Pareamento: o aparelho pede codigo e faz polling (sem conta ainda). ──
    if (p === '/devices/codigo' && req.method === 'POST') {
      try {
        const { nome } = JSON.parse((await lerCorpo(req)).toString() || '{}');
        return json(res, 200, pedirCodigo(nome));
      } catch (err) {
        return json(res, 400, { erro: err.message });
      }
    }
    if (p === '/devices/conferir') {
      return json(res, 200, conferirCodigo(url.searchParams.get('codigo')));
    }
    // O cerebro de voz valida o token do aparelho aqui.
    if (p === '/devices/ping') {
      const t = req.headers['x-device-token'] || tokenDaReq(req, url);
      return aparelhoValido(t) ? json(res, 200, { ok: true }) : json(res, 401, { erro: 'aparelho nao pareado' });
    }

    // ── Daqui pra baixo, tudo exige um ator: pessoa OU aparelho pareado. ────
    const quem = ator(req, url);
    if (!quem) return json(res, 401, { erro: 'faca login' });

    // Aprovar codigo e listar aparelhos so uma PESSOA faz (no app, com senha).
    // Um painel nao pode aprovar a si mesmo nem ver a frota da conta.
    if (p === '/devices/aprovar' && req.method === 'POST') {
      if (quem.tipo !== 'pessoa') return json(res, 403, { erro: 'so uma pessoa aprova aparelho' });
      try {
        const { codigo } = JSON.parse((await lerCorpo(req)).toString() || '{}');
        return json(res, 200, aprovarCodigo(codigo, quem.user));
      } catch (err) {
        return json(res, 400, { erro: err.message });
      }
    }
    if (p === '/devices/meus') {
      if (quem.tipo !== 'pessoa') return json(res, 403, { erro: 'so uma pessoa lista aparelhos' });
      const lista = aparelhosDe(quem.user).map((a) => ({ ...a, online: (presenca.get(a.id) || 0) > 0 }));
      return json(res, 200, { aparelhos: lista });
    }
    if (p === '/devices/remover' && req.method === 'POST') {
      if (quem.tipo !== 'pessoa') return json(res, 403, { erro: 'so uma pessoa remove aparelho' });
      try {
        const { id } = JSON.parse((await lerCorpo(req)).toString() || '{}');
        return json(res, 200, removerAparelho(id, quem.user));
      } catch (err) {
        return json(res, 400, { erro: err.message });
      }
    }

    // Estado ao vivo (SSE). O token veio no ?token= — ja validado acima.
    if (p === '/estado') {
      let primeiro;
      try {
        primeiro = JSON.stringify({ ...snapshot(), vitais, tempo, capacidades: caps });
      } catch (err) {
        return json(res, 500, { erro: `nao consegui ler o estado: ${err.message}` });
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(`data: ${primeiro}\n\n`);
      clientes.add(res);
      // Se quem abriu foi um painel, ele passa a contar como "ligado".
      const idPainel = quem.tipo === 'aparelho' ? quem.device.id : null;
      if (idPainel) marcarPresenca(idPainel, +1);
      req.on('close', () => {
        clientes.delete(res);
        if (idPainel) marcarPresenca(idPainel, -1);
      });
      return;
    }

    // Texto do app.
    if (p === '/v1/texto' && req.method === 'POST') {
      try {
        const { texto } = JSON.parse((await lerCorpo(req)).toString() || '{}');
        const r = await route(String(texto || ''), { source: 'app' });
        return json(res, 200, { resposta: r.reply, steps: r.steps });
      } catch (err) {
        return json(res, 200, { erro: err.message });
      }
    }

    // Comando digitado no HUD.
    if (p === '/comando' && req.method === 'POST') {
      try {
        const { texto } = JSON.parse((await lerCorpo(req)).toString() || '{}');
        const r = await route(String(texto || ''), { source: 'hud' });
        return json(res, 200, { ok: true, reply: r.reply });
      } catch (err) {
        return json(res, 200, { ok: false, erro: err.message });
      }
    }

    // Voz: repassa o audio pro cerebro na nuvem com o token do servidor.
    if (p === '/voz' && req.method === 'POST') {
      if (!VOZ_URL) {
        return json(res, 200, { resposta: 'A voz pela nuvem ainda nao esta configurada aqui.', audio: null });
      }
      try {
        const audio = await lerCorpo(req, 8 * 1024 * 1024);
        const r = await fetch(`${VOZ_URL}/v1/audio`, {
          method: 'POST',
          headers: { 'content-type': req.headers['content-type'] || 'audio/webm', authorization: `Bearer ${VOZ_TOKEN}` },
          body: audio,
        });
        const corpo = await r.text();
        res.writeHead(r.status, { 'content-type': 'application/json; charset=utf-8' });
        return res.end(corpo);
      } catch (err) {
        return json(res, 200, { erro: err.message, resposta: 'Nao alcancei o cerebro de voz.', audio: null });
      }
    }

    // Fotos e central de controle (Wi-Fi, ajustes, compras…): mesmas do HUD.
    if (await atenderControle(req, res, url)) return;

    json(res, 404, { erro: `rota desconhecida: ${p}` });
  }

  // ── Estado empurrado pros clientes conectados, como no HUD. ───────────────
  const emitir = () => {
    if (!clientes.size) return;
    let linha;
    try {
      linha = `data: ${JSON.stringify({ ...snapshot(), vitais, tempo, capacidades: caps })}\n\n`;
    } catch (err) {
      console.error(`[nucleus] falhei ao montar o estado: ${err.message}`);
      return;
    }
    for (const c of clientes) {
      try { c.write(linha); } catch { clientes.delete(c); }
    }
  };
  const tickEstado = setInterval(emitir, 1000);

  const lerTempo = async () => {
    try {
      const dados = await previsao();
      tempo = dados ? { ...dados, mostrar: deveMostrar(dados) } : null;
    } catch (err) {
      console.error(`[nucleus] previsao indisponivel: ${err.message}`);
    }
  };
  lerTempo();
  const tickTempo = setInterval(lerTempo, 5 * 60 * 1000);

  capacidades().then((c) => { caps = c; }).catch(() => { caps = null; });

  const batida = setInterval(() => {
    for (const c of clientes) {
      try { c.write(': ping\n\n'); } catch { clientes.delete(c); }
    }
  }, 25000);

  servidor.on('error', (err) => console.error(`[nucleus] erro no servidor: ${err.message}`));
  servidor.listen(port, host);
  return {
    port,
    stop() {
      clearInterval(tickEstado);
      clearInterval(tickTempo);
      clearInterval(batida);
      for (const c of clientes) c.end();
      servidor.close();
    },
  };
}
