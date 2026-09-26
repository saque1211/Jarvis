import crypto from 'node:crypto';
import path from 'node:path';
import { config, loadJson, saveJson } from '../core/config.js';

/**
 * Contas e sessao do nucleus — sem banco, no mesmo estilo do vault.
 *
 * Duas pecas: pessoas (email + senha) e aparelhos (o Pi/HUD pareado). Tudo em
 * JSON no vault. Senha nunca fica em claro (scrypt com sal por conta), e o
 * token de sessao e um JWT assinado por HMAC — validavel sem consultar disco,
 * pra cada requisicao do HUD nao virar uma leitura de arquivo.
 *
 * O que NAO tem, de proposito: recuperacao de senha por email (precisaria de
 * um servico de email e some do escopo local), e refresh token (o de sessao
 * dura 30 dias; reentrar e barato). Ambos entram quando o nucleus sair do PC.
 */

const ARQ_CONTAS = () => path.join(config.vaultPath, 'contas.json');
const ARQ_DISPOSITIVOS = () => path.join(config.vaultPath, 'dispositivos.json');
const ARQ_SEGREDO = () => path.join(config.vaultPath, '.segredo-nucleus.json');

const DIAS = 24 * 60 * 60 * 1000;
const VALIDADE_SESSAO = 30 * DIAS;

/**
 * Segredo que assina os tokens. Vem do .env se a pessoa definiu; senao um
 * aleatorio persistido no vault. Fixar no disco importa: gerar um novo a cada
 * boot deslogaria todo mundo em cada reinicio do processo.
 */
function segredo() {
  if (process.env.JARVIS_NUCLEUS_SECRET) return process.env.JARVIS_NUCLEUS_SECRET;
  const guardado = loadJson(ARQ_SEGREDO(), null);
  if (guardado?.chave) return guardado.chave;
  const nova = crypto.randomBytes(48).toString('hex');
  saveJson(ARQ_SEGREDO(), { chave: nova, criadoEm: new Date().toISOString() });
  return nova;
}

// ── Senha ────────────────────────────────────────────────────────────────

/**
 * scrypt, sempre ASSINCRONO.
 *
 * A versao Sync trava o laco de eventos do Node enquanto calcula — sao
 * centenas de milissegundos num Raspberry com a CPU freada. Durante um login o
 * nucleus inteiro congela: o painel para de receber estado, o app para de
 * responder. E, num servidor exposto na internet, tentar senha repetidamente
 * vira uma forma barata de derrubar a casa toda. A versao assincrona faz a
 * mesma conta na fila de trabalho, sem segurar ninguem.
 */
function scrypt(senha, sal, tamanho) {
  return new Promise((ok, falha) => {
    crypto.scrypt(senha, sal, tamanho, (err, chave) => (err ? falha(err) : ok(chave)));
  });
}

/** scrypt com sal aleatorio. Formato guardado: scrypt$<sal hex>$<hash hex>. */
async function embaralharSenha(senha) {
  const sal = crypto.randomBytes(16);
  const hash = await scrypt(senha, sal, 64);
  return `scrypt$${sal.toString('hex')}$${hash.toString('hex')}`;
}

/** Compara em tempo constante: comparar hash com === vaza informacao no tempo. */
async function senhaConfere(senha, guardado) {
  try {
    const [algo, salHex, hashHex] = String(guardado).split('$');
    if (algo !== 'scrypt') return false;
    const esperado = Buffer.from(hashHex, 'hex');
    const veio = await scrypt(senha, Buffer.from(salHex, 'hex'), esperado.length);
    return crypto.timingSafeEqual(esperado, veio);
  } catch {
    return false;
  }
}

// ── JWT (HMAC-SHA256) ──────────────────────────────────────────────────────

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function deB64url(txt) {
  return Buffer.from(String(txt).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function assinar(dados) {
  const cabeca = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const corpo = b64url(JSON.stringify(dados));
  const base = `${cabeca}.${corpo}`;
  const sig = b64url(crypto.createHmac('sha256', segredo()).update(base).digest());
  return `${base}.${sig}`;
}

/** Devolve o payload se o token for valido e nao vencido; senao null. */
export function verificarToken(token) {
  if (!token || typeof token !== 'string') return null;
  const partes = token.split('.');
  if (partes.length !== 3) return null;
  const base = `${partes[0]}.${partes[1]}`;
  const esperada = crypto.createHmac('sha256', segredo()).update(base).digest();
  let veio;
  try {
    veio = deB64url(partes[2]);
  } catch {
    return null;
  }
  if (esperada.length !== veio.length || !crypto.timingSafeEqual(esperada, veio)) return null;
  let dados;
  try {
    dados = JSON.parse(deB64url(partes[1]).toString('utf8'));
  } catch {
    return null;
  }
  if (!dados.exp || Date.now() > dados.exp) return null;
  return dados;
}

// ── Pessoas ────────────────────────────────────────────────────────────────

function lerContas() {
  return loadJson(ARQ_CONTAS(), { usuarios: [] });
}
function gravarContas(dados) {
  saveJson(ARQ_CONTAS(), dados);
}

function normalizarEmail(email) {
  return String(email || '').trim().toLowerCase();
}

/**
 * Freio de tentativa de senha.
 *
 * Sem isto, um servidor na internet aceita quantos palpites o atacante quiser,
 * o dia inteiro. Com uma espera que dobra a cada erro, adivinhar deixa de ser
 * viavel — e quem so errou a propria senha uma vez nao sente nada.
 *
 * A contagem e por email e por origem: travar so por email deixaria alguem
 * trancar a SUA conta de proposito, errando a senha de longe.
 */
const TENTATIVAS_LIVRES = 5;
const ESPERA_BASE = 2000;
const ESQUECE_EM = 15 * 60 * 1000;
const falhas = new Map(); // chave -> { n, ultima }

function chaveFreio(email, origem) {
  return `${normalizarEmail(email)}|${origem || '?'}`;
}

/** Quanto falta esperar, em ms. Zero quando esta liberado. */
export function esperaDoFreio(email, origem) {
  const f = falhas.get(chaveFreio(email, origem));
  if (!f) return 0;
  if (Date.now() - f.ultima > ESQUECE_EM) {
    falhas.delete(chaveFreio(email, origem));
    return 0;
  }
  if (f.n < TENTATIVAS_LIVRES) return 0;
  // 2s, 4s, 8s… com teto de 5 min: incomoda um robo, nao uma pessoa.
  const punicao = Math.min(300000, ESPERA_BASE * 2 ** (f.n - TENTATIVAS_LIVRES));
  return Math.max(0, punicao - (Date.now() - f.ultima));
}

function anotarFalha(email, origem) {
  const k = chaveFreio(email, origem);
  const f = falhas.get(k) || { n: 0, ultima: 0 };
  f.n++;
  f.ultima = Date.now();
  falhas.set(k, f);
  // O mapa nao pode crescer pra sempre num servidor aberto.
  if (falhas.size > 5000) {
    const limite = Date.now() - ESQUECE_EM;
    for (const [chave, v] of falhas) if (v.ultima < limite) falhas.delete(chave);
  }
}

function limparFalhas(email, origem) {
  falhas.delete(chaveFreio(email, origem));
}

/** Cria uma conta. Erros sao mensagens falaveis, ja em portugues. */
export async function registrar(email, senha) {
  const e = normalizarEmail(email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error('Email invalido.');
  if (!senha || senha.length < 8) throw new Error('A senha precisa de 8 caracteres ou mais.');

  const dados = lerContas();
  if (dados.usuarios.some((u) => u.email === e)) throw new Error('Ja existe uma conta com esse email.');

  const usuario = {
    id: crypto.randomUUID(),
    email: e,
    senha: await embaralharSenha(senha),
    criadoEm: new Date().toISOString(),
  };
  dados.usuarios.push(usuario);
  gravarContas(dados);
  return { token: novoToken(usuario), user: publico(usuario) };
}

/** Entra numa conta existente. Mensagem unica pra nao dizer se o email existe. */
export async function entrar(email, senha, origem) {
  const e = normalizarEmail(email);

  const falta = esperaDoFreio(e, origem);
  if (falta > 0) {
    throw new Error(`Muitas tentativas. Espere ${Math.ceil(falta / 1000)} segundos.`);
  }

  const dados = lerContas();
  const usuario = dados.usuarios.find((u) => u.email === e);
  if (!usuario || !(await senhaConfere(senha, usuario.senha))) {
    anotarFalha(e, origem);
    throw new Error('Email ou senha incorretos.');
  }
  limparFalhas(e, origem);
  return { token: novoToken(usuario), user: publico(usuario) };
}

/** Resolve o token numa pessoa. Devolve null se o token nao vale mais. */
export function usuarioDoToken(token) {
  const payload = verificarToken(token);
  if (!payload?.sub) return null;
  const usuario = lerContas().usuarios.find((u) => u.id === payload.sub);
  return usuario ? publico(usuario) : null;
}

function novoToken(usuario) {
  const agora = Date.now();
  return assinar({ sub: usuario.id, email: usuario.email, iat: agora, exp: agora + VALIDADE_SESSAO });
}

/** So o que pode sair pro cliente. A senha nunca. */
function publico(usuario) {
  return { id: usuario.id, email: usuario.email, criadoEm: usuario.criadoEm };
}

// ── Aparelhos (pareamento do Pi/HUD) ────────────────────────────────────────

function lerDispositivos() {
  return loadJson(ARQ_DISPOSITIVOS(), { aparelhos: [], codigos: [] });
}
function gravarDispositivos(dados) {
  saveJson(ARQ_DISPOSITIVOS(), dados);
}

const VALIDADE_CODIGO = 10 * 60 * 1000; // 10 min pra digitar o codigo no app

/**
 * O aparelho (Pi/HUD sem conta) pede um codigo curto. Ele mostra o codigo na
 * tela; a pessoa, logada no app, aprova. So entao o aparelho ganha um token.
 * Codigo de 6 digitos e o que cabe ser lido de um painel a distancia.
 */
export function pedirCodigo(nome) {
  const dados = lerDispositivos();
  const agora = Date.now();
  dados.codigos = dados.codigos.filter((c) => c.expira > agora && !c.token); // limpa vencidos/usados
  const codigo = String(Math.floor(100000 + Math.random() * 900000));
  // Segredo de polling: separado do codigo publico. O aparelho fala o codigo em
  // voz alta, mas faz polling com ISTO — quem ouvir o codigo nao rouba o token.
  const pollSecret = crypto.randomBytes(24).toString('hex');
  dados.codigos.push({ codigo, pollSecret, nome: String(nome || 'Aparelho'), criadoEm: agora, expira: agora + VALIDADE_CODIGO, token: null, deviceId: null });
  gravarDispositivos(dados);
  return { codigo, pollSecret, expira_em: VALIDADE_CODIGO };
}

/** A pessoa logada aprova o codigo mostrado no aparelho. */
export function aprovarCodigo(codigo, usuario) {
  const dados = lerDispositivos();
  const agora = Date.now();
  const pedido = dados.codigos.find((c) => c.codigo === String(codigo) && c.expira > agora && !c.token);
  if (!pedido) throw new Error('Codigo invalido ou expirado.');

  const token = crypto.randomBytes(32).toString('hex');
  const aparelho = {
    id: crypto.randomUUID(),
    nome: pedido.nome,
    token,
    dono: usuario.id,
    donoEmail: usuario.email,
    criadoEm: new Date().toISOString(),
  };
  dados.aparelhos.push(aparelho);
  pedido.token = token; // o aparelho, fazendo polling, encontra e guarda
  pedido.deviceId = aparelho.id;
  gravarDispositivos(dados);
  return { nome: aparelho.nome };
}

/** O aparelho faz polling neste ate o codigo ser aprovado (por codigo). */
/**
 * Estado de um codigo — e SO o estado. Nunca o token.
 *
 * Esta rota e aberta por necessidade: o painel ainda nao tem credencial
 * nenhuma quando pergunta pelo proprio codigo. Ela respondia com o token do
 * aparelho, e isso fazia de um numero de 6 digitos — que aparece na tela e as
 * vezes e dito em voz alta — a chave de acesso ao assistente inteiro. Um
 * milhao de combinacoes nao e segredo; e um cadeado de bicicleta.
 *
 * Quem espera o token faz polling por `pollSecret`, que tem 24 bytes
 * aleatorios e nunca aparece na tela. Era a razao de ele existir; faltava o
 * painel usar.
 */
export function conferirCodigo(codigo) {
  const pedido = lerDispositivos().codigos.find((c) => c.codigo === String(codigo));
  if (!pedido) return { estado: 'inexistente' };
  if (pedido.token) return { estado: 'aprovado' };
  if (pedido.expira <= Date.now()) return { estado: 'expirado' };
  return { estado: 'aguardando' };
}

/** Polling por segredo (o cliente do Pi): nao expoe o token pelo codigo publico. */
export function conferirPorSegredo(pollSecret) {
  const dados = lerDispositivos();
  const pedido = dados.codigos.find((c) => c.pollSecret === pollSecret);
  if (!pedido) return { encontrado: false };
  if (pedido.token) return { encontrado: true, approved: true, deviceToken: pedido.token, device: { id: pedido.deviceId, name: pedido.nome } };
  if (pedido.expira <= Date.now()) return { encontrado: true, approved: false, expirado: true };
  return { encontrado: true, approved: false };
}

/** Valida o token de um aparelho (usado pelo /devices/ping do cerebro). */
export function aparelhoValido(token) {
  if (!token) return false;
  return lerDispositivos().aparelhos.some((a) => a.token === token);
}

/**
 * Resolve o token num aparelho pareado. Um painel de parede nao tem senha —
 * ele age em nome de quem o aprovou. Nunca devolve o token de volta.
 */
export function aparelhoDoToken(token) {
  if (!token) return null;
  const a = lerDispositivos().aparelhos.find((x) => x.token === token);
  return a ? { id: a.id, nome: a.nome, dono: a.dono, donoEmail: a.donoEmail } : null;
}

/** Lista os aparelhos de uma pessoa, sem vazar o token. */
export function aparelhosDe(usuario) {
  return lerDispositivos()
    .aparelhos.filter((a) => a.dono === usuario.id)
    .map((a) => ({ id: a.id, nome: a.nome, criadoEm: a.criadoEm }));
}

/** Remove um aparelho — so o dono. O painel desligado cai pro pareamento de novo. */
export function removerAparelho(id, usuario) {
  const dados = lerDispositivos();
  const antes = dados.aparelhos.length;
  dados.aparelhos = dados.aparelhos.filter((a) => !(a.id === id && a.dono === usuario.id));
  if (dados.aparelhos.length === antes) throw new Error('Aparelho nao encontrado.');
  gravarDispositivos(dados);
  return { ok: true };
}
