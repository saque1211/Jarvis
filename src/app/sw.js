/*
 * Service worker minimo.
 *
 * Existe por dois motivos, e nenhum deles e cache agressivo: sem service
 * worker o Android nao oferece "instalar na tela inicial", e sem a casca
 * guardada o app abre em branco quando o celular sai da rede de casa — que e
 * exatamente quando ele nao pode parecer quebrado.
 *
 * Os DADOS nunca sao guardados. Uma lista de compras de ontem servida como se
 * fosse a de hoje e pior que um erro de rede: o erro voce ve, a lista velha
 * voce acredita.
 */
const CASCA = 'vexis-casca-v2';
const ARQUIVOS = ['/app', '/app/manifest.json', '/app/icone.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CASCA).then((c) => c.addAll(ARQUIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ns) => Promise.all(ns.filter((n) => n !== CASCA).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // Só a casca. Estado, config, compras e avisos vão sempre à rede.
  if (!ARQUIVOS.includes(url.pathname)) return;
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        const copia = r.clone();
        caches.open(CASCA).then((c) => c.put(e.request, copia));
        return r;
      })
      .catch(() => caches.match(e.request))
  );
});
