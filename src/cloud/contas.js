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

/** scrypt com sal aleatorio. Formato guardado: scrypt$<sal hex>$<hash hex>. */
function embaralharSenha(senha) {
  const sal = crypto.randomBytes(16);
  const hash = crypto.scryptSync(senha, sal, 64);
  return `scrypt$${sal.toString('hex')}$${hash.toString('hex')}`;
}

/** Compara em tempo constante: comparar hash com === vaza informacao no tempo. */
function senhaConfere(senha, guardado) {
  try {
    const [algo, salHex, hashHex] = String(guardado).split('$');
    if (algo !== 'scrypt') return false;
    const esperado = Buffer.from(hashHex, 'hex');
    const veio = crypto.scryptSync(senha, Buffer.from(salHex, 'hex'), esperado.length);
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

/** Cria uma conta. Erros sao mensagens falaveis, ja em portugues. */
export function registrar(email, senha) {
  const e = normalizarEmail(email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error('Email invalido.');
  if (!senha || senha.length < 8) throw new Error('A senha precisa de 8 caracteres ou mais.');

  const dados = lerContas();
  if (dados.usuarios.some((u) => u.email === e)) throw new Error('Ja existe uma conta com esse email.');

  const usuario = {
    id: crypto.randomUUID(),
    email: e,
    senha: embaralharSenha(senha),
    criadoEm: new Date().toISOString(),
  };
  dados.usuarios.push(usuario);
  gravarContas(dados);
  return { token: novoToken(usuario), user: publico(usuario) };
}

/** Entra numa conta existente. Mensagem unica pra nao dizer se o email existe. */
export function entrar(email, senha) {
  const e = normalizarEmail(email);
  const dados = lerContas();
  const usuario = dados.usuarios.find((u) => u.email === e);
  if (!usuario || !senhaConfere(senha, usuario.senha)) {
    throw new Error('Email ou senha incorretos.');
  }
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
  dados.codigos.push({ codigo, nome: String(nome || 'Aparelho'), criadoEm: agora, expira: agora + VALIDADE_CODIGO, token: null });
  gravarDispositivos(dados);
  return { codigo, expira_em: VALIDADE_CODIGO };
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
  gravarDispositivos(dados);
  return { nome: aparelho.nome };
}

/** O aparelho faz polling neste ate o codigo ser aprovado. */
export function conferirCodigo(codigo) {
  const dados = lerDispositivos();
  const pedido = dados.codigos.find((c) => c.codigo === String(codigo));
  if (!pedido) return { estado: 'inexistente' };
  if (pedido.token) return { estado: 'aprovado', token: pedido.token };
  if (pedido.expira <= Date.now()) return { estado: 'expirado' };
  return { estado: 'aguardando' };
}

/** Valida o token de um aparelho (usado pelo /devices/ping do cerebro). */
export function aparelhoValido(token) {
  if (!token) return false;
  return lerDispositivos().aparelhos.some((a) => a.token === token);
}

/** Lista os aparelhos de uma pessoa, sem vazar o token. */
export function aparelhosDe(usuario) {
  return lerDispositivos()
    .aparelhos.filter((a) => a.dono === usuario.id)
    .map((a) => ({ id: a.id, nome: a.nome, criadoEm: a.criadoEm }));
}
