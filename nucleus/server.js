import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { snapshot } from '../src/core/state.js';
import { atenderControle } from '../src/hud/controle.js';
import { verificarJwt } from './middleware/auth.js';
import authRoutes from './routes/auth.js';
import deviceRoutes from './routes/devices.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Alem do .env do nucleus, le o .env do projeto principal — e la que mora o
// JARVIS_CLOUD_TOKEN, que este servidor usa pra repassar a voz por dentro.
// Sem `override`: o que ja veio do .env do nucleus manda.
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// O app das 5 abas e os dados vivem no projeto principal. O nucleus os serve
// de la em vez de duplicar — e o MESMO app que roda no HUD do PC, agora pela
// nuvem, com os mesmos endpoints (/config, /fotos, /compras, /avisos, /estado).
const APP_DIR = path.join(__dirname, '..', 'src', 'app');

// Servidor de voz (STT + cerebro + TTS). O nucleus fala com ele por dentro do
// VPS, guardando o token do lado do servidor pra ele nunca ir pro navegador.
const VOZ_URL = (process.env.JARVIS_VOZ_URL || 'http://localhost:8080').replace(/\/$/, '');
const VOZ_TOKEN = process.env.JARVIS_CLOUD_TOKEN || '';

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/health', (req, res) => {
  res.json({ ok: true, version: '2.0.0' });
});

// ── App completo + dados ─────────────────────────────────────────────────────
// Isto roda ANTES do express.json de proposito: o atenderControle le o corpo
// cru das requisicoes (ele mesmo faz o parse). Se o express.json rodasse antes,
// consumiria o corpo e um POST de lista/aviso chegaria vazio.
const clientesEstado = new Set();

function servirArquivo(res, arquivo, tipo, cache) {
  if (!fs.existsSync(arquivo)) return false;
  res.writeHead(200, {
    'content-type': `${tipo}; charset=utf-8`,
    ...(cache ? { 'cache-control': cache } : {}),
  });
  res.end(fs.readFileSync(arquivo));
  return true;
}

// Le o corpo bruto (audio) com teto — um POST torto nao pode encher a memoria.
const LIMITE_AUDIO = 8 * 1024 * 1024;
function lerBinario(req) {
  return new Promise((resolve, reject) => {
    const partes = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > LIMITE_AUDIO) {
        req.destroy();
        reject(new Error('áudio grande demais'));
        return;
      }
      partes.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(partes)));
    req.on('error', reject);
  });
}

app.use(async (req, res, next) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  // As paginas HTML vao com 'no-cache' pra o navegador SEMPRE revalidar — sem
  // isto, uma versao velha do app fica presa no cache do navegador e a pessoa
  // precisa de aba anonima pra ver a nova. ('no-cache' nao e "nao guarde"; e
  // "guarde, mas confirme com o servidor antes de usar".)
  const semCache = 'no-cache';

  // Portal de conta e pareamento (login + parear dispositivo).
  if (p === '/conta' || p === '/conta/') {
    return servirArquivo(res, path.join(__dirname, 'public', 'index.html'), 'text/html', semCache);
  }

  // O app das 5 abas — na raiz e em /app (onde o service worker espera achar).
  if (p === '/' || p === '/app' || p === '/app/') {
    return servirArquivo(res, path.join(APP_DIR, 'index.html'), 'text/html', semCache);
  }

  // O HUD — o painel de parede (relogio, tempo, fotos, avisos). Mesma casca
  // aberta; o proprio HUD manda pro /app se nao houver login.
  if (p === '/hud' || p === '/hud/' || p === '/painel') {
    return servirArquivo(res, path.join(__dirname, '..', 'src', 'hud', 'index.html'), 'text/html', semCache);
  }

  const asset = /^\/app\/(manifest\.json|sw\.js|icone(?:-mascara)?\.png)$/.exec(p);
  if (asset) {
    const tipo = asset[1].endsWith('.json')
      ? 'application/manifest+json'
      : asset[1].endsWith('.js')
        ? 'text/javascript'
        : 'image/png';
    // sw.js nunca em cache: um service worker velho serve casca velha pra
    // sempre e nao ha como consertar de fora.
    const cache = asset[1] === 'sw.js' ? 'no-cache' : 'public, max-age=86400';
    if (servirArquivo(res, path.join(APP_DIR, asset[1]), tipo, cache)) return;
  }

  // Login e pareamento passam direto pro express.json + routers — eles fazem a
  // propria autenticacao (o /auth/login nem PODE exigir login, senao ninguem
  // entra). So o /voz e as rotas de dados abaixo e que passam pelo portao.
  if (p.startsWith('/auth') || p.startsWith('/devices')) return next();

  // Fotos de fundo sao imagens em <img src>, que nao mandam cabecalho de login.
  // Servi-las abertas (sao so papel de parede) evita quebrar a tela; o que MUDA
  // fotos (enviar, apagar) e a lista seguem exigindo login mais abaixo.
  if (req.method === 'GET' && /^\/fotos\/[\w.-]+$/.test(p)) {
    if (await atenderControle(req, res, url)) return;
  }

  // Daqui pra baixo e tudo dado — exige estar logado. A casca do app (acima)
  // fica aberta pra a tela de login carregar; o conteudo, nao. Sem isto, o app
  // na internet ficaria com a lista e os avisos abertos pra qualquer um.
  const sessao = verificarJwt(req, url);
  if (!sessao) {
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ erro: 'Faça login.' }));
    return;
  }

  // Voz: o navegador manda o audio aqui (ja logado), e o nucleus repassa pro
  // servidor de voz com o token do servidor. O token nunca aparece no navegador.
  if (p === '/voz' && req.method === 'POST') {
    try {
      const audio = await lerBinario(req);
      const r = await fetch(`${VOZ_URL}/v1/audio`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${VOZ_TOKEN}`,
          'content-type': req.headers['content-type'] || 'audio/webm',
        },
        body: audio,
      });
      const corpo = await r.text();
      res.writeHead(r.status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(corpo);
    } catch (err) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ erro: `voz indisponível: ${err.message}` }));
    }
    return;
  }

  // Estado ao vivo (SSE) — a Casa do app se atualiza sozinha por aqui.
  if (p === '/estado') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    try {
      res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    } catch {
      /* mesmo sem o primeiro pacote, o cliente recebe o proximo tick */
    }
    clientesEstado.add(res);
    req.on('close', () => clientesEstado.delete(res));
    return;
  }

  // Fotos, lista, avisos, config, volume, sistema — tudo do HUD, reaproveitado.
  try {
    if (await atenderControle(req, res, url)) return;
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ erro: err.message }));
    }
    return;
  }

  next();
});

// Empurra o estado pra quem esta ouvindo. Sem trafego, proxy e operadora
// derrubam a conexao ociosa; um comentario a cada tick tambem serve de batida.
setInterval(() => {
  if (!clientesEstado.size) return;
  let linha;
  try {
    linha = `data: ${JSON.stringify(snapshot())}\n\n`;
  } catch {
    return;
  }
  for (const c of clientesEstado) {
    try {
      c.write(linha);
    } catch {
      clientesEstado.delete(c);
    }
  }
}, 1000);

// ── Contas e pareamento (precisam do JSON parseado) ──────────────────────────
app.use(express.json());
app.use('/auth', authRoutes);
app.use('/devices', deviceRoutes);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ erro: 'Erro interno do servidor.' });
});

app.listen(PORT, () => {
  console.log(`[nucleus] escutando em porta ${PORT}`);
});
