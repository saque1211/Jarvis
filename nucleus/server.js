import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshot } from '../src/core/state.js';
import { atenderControle } from '../src/hud/controle.js';
import authRoutes from './routes/auth.js';
import deviceRoutes from './routes/devices.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// O app das 5 abas e os dados vivem no projeto principal. O nucleus os serve
// de la em vez de duplicar — e o MESMO app que roda no HUD do PC, agora pela
// nuvem, com os mesmos endpoints (/config, /fotos, /compras, /avisos, /estado).
const APP_DIR = path.join(__dirname, '..', 'src', 'app');

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

app.use(async (req, res, next) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  // Portal de conta e pareamento (login + parear dispositivo).
  if (p === '/conta' || p === '/conta/') {
    return servirArquivo(res, path.join(__dirname, 'public', 'index.html'), 'text/html');
  }

  // O app das 5 abas — na raiz e em /app (onde o service worker espera achar).
  if (p === '/' || p === '/app' || p === '/app/') {
    return servirArquivo(res, path.join(APP_DIR, 'index.html'), 'text/html');
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
