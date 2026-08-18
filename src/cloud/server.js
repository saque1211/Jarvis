import http from 'node:http';
import crypto from 'node:crypto';
import { route } from '../core/router.js';
import { snapshot } from '../core/state.js';
import { transcreverNaNuvem } from './stt.js';
import { sintetizar, ttsConfigurado } from './tts.js';

/**
 * Servidor do JARVIS na nuvem.
 *
 * Ele e o cerebro: recebe audio do Pi, transcreve, roteia pelo mesmo router de
 * sempre, sintetiza a resposta e devolve os bytes. O Pi so grava e toca — o
 * que cabe nos 512 MB dele.
 *
 * Isto fica exposto na internet, entao TODA rota exige token. Um assistente
 * aberto e um executor de comandos aberto.
 */

const LIMITE_AUDIO = 8 * 1024 * 1024; // ~4 min de WAV 16 kHz mono

function autorizado(req) {
  const esperado = process.env.JARVIS_CLOUD_TOKEN;
  if (!esperado) return false;
  const veio = (req.headers.authorization || '').replace(/^Bearer /i, '');
  if (veio.length !== esperado.length) return false;
  // Comparacao de tempo constante: comparar com === vaza o tamanho do prefixo
  // certo pelo tempo de resposta, e o token e o unico portao daqui.
  return crypto.timingSafeEqual(Buffer.from(veio), Buffer.from(esperado));
}

function json(res, status, corpo) {
  const texto = JSON.stringify(corpo);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(texto);
}

function lerCorpo(req, limite) {
  return new Promise((resolve, reject) => {
    const pedacos = [];
    let total = 0;
    let estourou = false;
    req.on('data', (c) => {
      if (estourou) return;
      total += c.length;
      if (total > limite) {
        estourou = true;
        // Nao destroi o socket aqui: sem ele a resposta 413 nao sai e o Pi ve
        // "fetch failed", que nao diz o que houve. Para de acumular (a memoria
        // ja esta protegida) e deixa quem chamou responder direito.
        pedacos.length = 0;
        const err = new Error('corpo grande demais');
        err.limite = true;
        reject(err);
        return;
      }
      pedacos.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(pedacos)));
    req.on('error', reject);
  });
}

export function startCloud({ port = 8080, host = '0.0.0.0' } = {}) {
  const ouvintes = new Set();

  const servidor = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');

    // Saude e a unica rota aberta: serve pro monitor do VPS saber se subiu, e
    // nao revela nada.
    if (url.pathname === '/saude') return json(res, 200, { ok: true, tts: ttsConfigurado() });

    if (!autorizado(req)) return json(res, 401, { erro: 'token invalido ou ausente' });

    // ── Pi: manda WAV, recebe resposta falada ────────────────────────────
    if (url.pathname === '/v1/audio' && req.method === 'POST') {
      try {
        const wav = await lerCorpo(req, LIMITE_AUDIO);
        if (!wav.length) return json(res, 400, { erro: 'audio vazio' });

        const transcricao = await transcreverNaNuvem(wav, url.searchParams.get('vocab'));
        if (!transcricao) {
          return json(res, 200, { transcricao: null, resposta: 'Nao entendi.', audio: null });
        }

        const r = await route(transcricao, { source: 'pi' });
        const fala = await sintetizar(r.reply);

        emitir();
        return json(res, 200, {
          transcricao,
          resposta: r.reply,
          // base64 em vez de rota separada: o Pi faz UMA requisicao e ja tem o
          // som. Duas viagens custariam outro RTT em cada comando.
          audio: fala ? fala.toString('base64') : null,
        });
      } catch (err) {
        if (err.limite) {
          return json(res, 413, {
            erro: `audio acima de ${Math.round(LIMITE_AUDIO / 1e6)} MB`,
            resposta: 'O audio ficou longo demais. Fale um comando mais curto.',
            audio: null,
          });
        }
        return json(res, 200, { erro: err.message, resposta: err.message, audio: null });
      }
    }

    // ── App do celular: manda texto ──────────────────────────────────────
    if (url.pathname === '/v1/texto' && req.method === 'POST') {
      try {
        const corpo = JSON.parse((await lerCorpo(req, 64 * 1024)).toString() || '{}');
        const texto = String(corpo.texto || '').trim();
        if (!texto) return json(res, 400, { erro: 'texto vazio' });

        const r = await route(texto, { source: 'app' });
        emitir();
        return json(res, 200, { resposta: r.reply, steps: r.steps });
      } catch (err) {
        return json(res, 200, { erro: err.message });
      }
    }

    // ── App: estado ao vivo ──────────────────────────────────────────────
    if (url.pathname === '/v1/estado') {
      if (url.searchParams.get('stream') === '1') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
        ouvintes.add(res);
        req.on('close', () => ouvintes.delete(res));
        return;
      }
      return json(res, 200, snapshot());
    }

    return json(res, 404, { erro: 'rota desconhecida' });
  });

  function emitir() {
    if (!ouvintes.size) return;
    const linha = `data: ${JSON.stringify(snapshot())}\n\n`;
    for (const o of ouvintes) {
      try {
        o.write(linha);
      } catch {
        ouvintes.delete(o);
      }
    }
  }

  // Batimento: sem trafego, proxy e operadora derrubam conexao ociosa, e o app
  // ficaria com a tela congelada sem saber que perdeu o fluxo.
  const batida = setInterval(() => {
    for (const o of ouvintes) {
      try {
        o.write(': ping\n\n');
      } catch {
        ouvintes.delete(o);
      }
    }
  }, 25000);

  servidor.listen(port, host);
  return {
    port,
    stop() {
      clearInterval(batida);
      for (const o of ouvintes) o.end();
      servidor.close();
    },
  };
}
