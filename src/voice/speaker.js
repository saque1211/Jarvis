import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';

/**
 * Alto-falante remoto: o celular vira a caixa de som do JARVIS.
 *
 * Em vez de tocar a fala na placa de som do PC, sintetiza pra arquivo e serve
 * por HTTP. Voce abre uma pagina no navegador do celular e ela toca cada
 * resposta assim que chega. Nao instala nada no telefone.
 *
 * Serve pra caixa de som quebrada, pra ouvir de outro comodo, ou pra fone
 * ligado no celular enquanto o PC fica mudo.
 */

const KEEP_MS = 120000; // quanto tempo um audio fica disponivel pra buscar

let server = null;
let listeners = [];
const audios = new Map();
let nextId = 1;

/** IP da maquina na rede local — o celular precisa dele, nao de localhost. */
export function lanAddress() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return '127.0.0.1';
}

const PAGE = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>JARVIS — alto-falante</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: #0b0d10; color: #e8eaed;
    font: 16px/1.5 system-ui, -apple-system, sans-serif;
    text-align: center; padding: 24px;
  }
  h1 { font-size: 15px; letter-spacing: .18em; text-transform: uppercase; color: #7c8a99; font-weight: 600; margin: 0 0 28px; }
  #dot { width: 12px; height: 12px; border-radius: 50%; background: #3a4450; margin: 0 auto 20px; transition: background .2s; }
  #dot.on { background: #35c46b; box-shadow: 0 0 16px #35c46b88; }
  #dot.playing { background: #4a9eff; box-shadow: 0 0 16px #4a9effaa; }
  button {
    font: inherit; font-weight: 600; color: #0b0d10; background: #e8eaed;
    border: 0; border-radius: 999px; padding: 16px 32px; cursor: pointer;
  }
  #status { color: #7c8a99; font-size: 14px; min-height: 1.5em; }
  #last { margin-top: 20px; color: #b9c2cc; font-size: 15px; max-width: 30ch; }
</style>
<h1>Jarvis</h1>
<div id="dot"></div>
<button id="go">Tocar aqui</button>
<div id="status"></div>
<div id="last"></div>
<script>
  const dot = document.getElementById('dot');
  const status = document.getElementById('status');
  const last = document.getElementById('last');
  const go = document.getElementById('go');
  const fila = [];
  let tocando = false;

  async function tocarProximo() {
    if (tocando || !fila.length) return;
    tocando = true;
    dot.className = 'playing';
    const item = fila.shift();
    last.textContent = item.text || '';
    try {
      const audio = new Audio(item.url);
      await audio.play();
      await new Promise((r) => { audio.onended = r; audio.onerror = r; });
    } catch (e) {
      status.textContent = 'nao consegui tocar: ' + e.message;
    }
    tocando = false;
    dot.className = 'on';
    tocarProximo();
  }

  function conectar() {
    const es = new EventSource('/events');
    es.onopen = () => { dot.className = 'on'; status.textContent = 'conectado'; };
    es.onmessage = (e) => { fila.push(JSON.parse(e.data)); tocarProximo(); };
    es.onerror = () => { dot.className = ''; status.textContent = 'reconectando...'; };
  }

  // O navegador so libera audio depois de um toque. Por isso o botao existe.
  go.onclick = async () => {
    try {
      const ctx = new AudioContext();
      await ctx.resume();
    } catch {}
    go.remove();
    status.textContent = 'conectando...';
    conectar();
  };
</script>`;

/** Sobe o servidor. Idempotente. */
export function startSpeaker(port) {
  if (server) return Promise.resolve(server);

  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
      return;
    }

    if (url.pathname === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(': conectado\n\n');
      listeners.push(res);
      req.on('close', () => {
        listeners = listeners.filter((l) => l !== res);
      });
      return;
    }

    const match = url.pathname.match(/^\/audio\/(\d+)\.wav$/);
    if (match) {
      const entry = audios.get(Number(match[1]));
      if (!entry || !fs.existsSync(entry.path)) {
        res.writeHead(404).end('expirou');
        return;
      }
      res.writeHead(200, {
        'content-type': 'audio/wav',
        'content-length': fs.statSync(entry.path).size,
      });
      fs.createReadStream(entry.path).pipe(res);
      return;
    }

    res.writeHead(404).end();
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => resolve(server));
  });
}

/** Quantos celulares estao com a pagina aberta. */
export function listenerCount() {
  return listeners.length;
}

/**
 * Manda um WAV pros ouvintes. Devolve false se ninguem esta escutando — quem
 * chama decide se cai de volta no alto-falante do PC.
 */
export function pushAudio(wavPath, text) {
  if (!listeners.length) return false;

  const id = nextId++;
  audios.set(id, { path: wavPath });

  // O audio precisa sobreviver ao GET que vem logo depois; alguns segundos nao
  // bastam se a rede estiver ruim, e guardar pra sempre enche o disco.
  setTimeout(() => {
    audios.delete(id);
    fs.rmSync(wavPath, { force: true });
  }, KEEP_MS).unref?.();

  const payload = JSON.stringify({ url: `/audio/${id}.wav`, text });
  for (const res of listeners) res.write(`data: ${payload}\n\n`);
  return true;
}

export function stopSpeaker() {
  for (const res of listeners) {
    try {
      res.end();
    } catch {
      // Encerrando de qualquer jeito.
    }
  }
  listeners = [];
  server?.close();
  server = null;
}
