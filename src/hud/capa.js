import https from 'node:https';

/**
 * Proxy da capa do album.
 *
 * Existe por um motivo so: o HUD precisa LER os pixels da capa pra tirar a cor
 * dominante e pintar a cena do player com a paleta do disco. A capa mora no CDN
 * do Spotify, e uma imagem de outra origem "suja" o canvas — `getImageData`
 * passa a lancar erro. Servindo a mesma imagem pela nossa origem, o canvas
 * volta a ser legivel.
 *
 * Repassa APENAS o CDN do Spotify. Um proxy que aceita qualquer URL vira um
 * jeito de fazer o servidor bater em endereco interno (SSRF) — e este processo
 * fala com o Home Assistant e com o nucleus na mesma rede.
 */

const PERMITIDOS = /(^|\.)scdn\.co$/i;

// A mesma capa e pedida a cada troca de faixa e a cada recarga do painel. Um
// cache curto na memoria evita ir ao CDN de novo — e nao encosta no cartao SD.
const CACHE_MAX = 8;
const cache = new Map(); // url -> { tipo, bytes, em }
const VALIDADE = 30 * 60 * 1000;

function guardar(url, item) {
  cache.set(url, item);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

function baixar(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 8000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`capa ${res.statusCode}`));
        return;
      }
      const pedacos = [];
      let total = 0;
      res.on('data', (c) => {
        total += c.length;
        // Capa de album nao passa disso; o teto evita um download sem fim.
        if (total > 3 * 1024 * 1024) {
          req.destroy();
          reject(new Error('capa grande demais'));
          return;
        }
        pedacos.push(c);
      });
      res.on('end', () => resolve({ tipo: res.headers['content-type'] || 'image/jpeg', bytes: Buffer.concat(pedacos) }));
    });
    req.on('timeout', () => req.destroy(new Error('capa demorou demais')));
    req.on('error', reject);
  });
}

/** Atende GET /capa?u=<url do CDN>. Devolve true quando tratou. */
export async function atenderCapa(req, res, url) {
  if (url.pathname !== '/capa') return false;

  const alvo = url.searchParams.get('u') || '';
  let destino;
  try {
    destino = new URL(alvo);
  } catch {
    res.writeHead(400).end('url invalida');
    return true;
  }
  if (destino.protocol !== 'https:' || !PERMITIDOS.test(destino.hostname)) {
    res.writeHead(403).end('origem nao permitida');
    return true;
  }

  const agora = Date.now();
  const guardada = cache.get(destino.href);
  if (guardada && agora - guardada.em < VALIDADE) {
    res.writeHead(200, { 'content-type': guardada.tipo, 'cache-control': 'public, max-age=1800' });
    res.end(guardada.bytes);
    return true;
  }

  try {
    const { tipo, bytes } = await baixar(destino.href);
    guardar(destino.href, { tipo, bytes, em: agora });
    res.writeHead(200, { 'content-type': tipo, 'cache-control': 'public, max-age=1800' });
    res.end(bytes);
  } catch (err) {
    // Sem capa o player ainda desenha (cai numa paleta neutra) — melhor que
    // derrubar a cena inteira por causa de uma imagem.
    res.writeHead(502).end(String(err.message || err));
  }
  return true;
}
