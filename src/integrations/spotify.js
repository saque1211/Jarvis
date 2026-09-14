import fs from 'node:fs';
import { config, saveJson, loadJson } from '../core/config.js';

/**
 * Cliente da Spotify Web API com refresh automatico de token.
 *
 * O fluxo de autorizacao roda uma vez via `npm run auth:spotify` (Authorization
 * Code + PKCE, servidor local no 8888). Depois disso o refresh token fica em
 * .secrets/spotify.json e este modulo se vira sozinho.
 */

const API = 'https://api.spotify.com/v1';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';

export const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'playlist-read-private',
  'user-library-read',
].join(' ');

function readTokens() {
  if (!fs.existsSync(config.spotify.tokenFile)) return null;
  return loadJson(config.spotify.tokenFile, null);
}

export function saveTokens(tokens) {
  saveJson(config.spotify.tokenFile, {
    ...tokens,
    expires_at: Date.now() + (tokens.expires_in ?? 3600) * 1000,
  });
}

async function refreshAccessToken(refreshToken) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: config.spotify.clientId,
  });
  // client_secret e opcional no PKCE, mas apps "classicos" ainda usam.
  if (config.spotify.clientSecret) body.set('client_secret', config.spotify.clientSecret);

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`Refresh do Spotify falhou: ${res.status} ${await res.text()}`);

  const tokens = await res.json();
  // A Spotify nem sempre devolve um refresh_token novo; preserve o antigo.
  saveTokens({ refresh_token: refreshToken, ...tokens });
  return tokens.access_token;
}

async function accessToken() {
  if (!config.spotify.clientId) {
    throw new Error('Falta SPOTIFY_CLIENT_ID no .env.');
  }
  const tokens = readTokens();
  if (!tokens?.refresh_token) {
    throw new Error('Spotify nao autorizado. Rode: npm run auth:spotify');
  }
  if (tokens.access_token && tokens.expires_at && Date.now() < tokens.expires_at - 60000) {
    return tokens.access_token;
  }
  return refreshAccessToken(tokens.refresh_token);
}

export function isConfigured() {
  return Boolean(config.spotify.clientId && readTokens()?.refresh_token);
}

/**
 * Escolhe um aparelho e assume a reproducao nele. Devolve o nome, ou null se
 * nao houver nenhum visivel.
 *
 * A ordem da preferencia e o ponto: o aparelho DESTA casa vem primeiro. Pedir
 * "toca musica" pro painel da sala e ver o som sair no celular de alguem que
 * esta na rua e pior que nao tocar.
 */
async function escolherAparelho() {
  const data = await request('GET', '/me/player/devices', { _semResgate: true });
  const aparelhos = data?.devices || [];
  if (!aparelhos.length) return null;

  const preferido = (process.env.SPOTIFY_DEVICE || 'vexis').toLowerCase();
  const alvo =
    aparelhos.find((d) => d.name.toLowerCase().includes(preferido)) ||
    aparelhos.find((d) => d.is_active) ||
    aparelhos[0];

  await request('PUT', '/me/player', {
    body: { device_ids: [alvo.id], play: false },
    _semResgate: true,
  });

  // A troca nao vale no instante em que e pedida. Esperar um tempo FIXO e o
  // erro classico: curto demais e o pedido seguinte ainda leva 404 (a musica
  // ate comeca, mas a resposta falada sai errada); longo demais e o assistente
  // fica mudo a toa. Entao perguntamos ate o aparelho se declarar ativo.
  const limite = Date.now() + 3000;
  while (Date.now() < limite) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      const agora = await request('GET', '/me/player/devices', { _semResgate: true });
      if ((agora?.devices || []).some((d) => d.id === alvo.id && d.is_active)) break;
    } catch {
      // Ainda trocando: tenta de novo ate o limite.
    }
  }
  return alvo.name;
}

async function request(method, endpoint, { body, query, _semResgate } = {}) {
  const token = await accessToken();
  const url = new URL(API + endpoint);
  if (query) for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, v);

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  // 204 = sucesso sem corpo (play/pause/next respondem assim).
  if (res.status === 204) return null;

  if (res.status === 404) {
    // 404 aqui quer dizer "nenhum aparelho ativo" — nao "rota inexistente". O
    // Spotify esquece o aparelho depois de um tempo parado, entao mandar o
    // usuario "abrir o app e tocar algo uma vez" e um conselho que vence: dez
    // minutos depois ele precisa fazer de novo. Se ha aparelho VISIVEL (o
    // raspotify do proprio painel, por exemplo), assumimos ele e repetimos.
    if (!_semResgate) {
      let nome = null;
      try {
        nome = await escolherAparelho();
      } catch {
        // Resgate e melhoria, nao obrigacao: falhando, cai no erro de sempre.
      }
      if (nome) return request(method, endpoint, { body, query, _semResgate: true });
    }
    throw new Error('Nenhum dispositivo Spotify ativo. Abra o Spotify e toque algo uma vez.');
  }

  if (!res.ok) throw new Error(`Spotify ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // Um "Unexpected token" solto nao diz nada sobre onde o problema esta. Diga
    // qual rota respondeu e com o que — e o que separa "a Spotify devolveu uma
    // pagina de erro" de "o corpo veio cortado".
    throw new Error(
      `Spotify respondeu algo que nao e JSON em ${method} ${endpoint} ` +
        `(${res.status}): ${text.slice(0, 80)}`
    );
  }
}

export const spotify = {
  play: (uris) => request('PUT', '/me/player/play', { body: uris ? { uris } : undefined }),
  playContext: (contextUri) => request('PUT', '/me/player/play', { body: { context_uri: contextUri } }),
  pause: () => request('PUT', '/me/player/pause'),
  next: () => request('POST', '/me/player/next'),
  previous: () => request('POST', '/me/player/previous'),
  setVolume: (percent) => request('PUT', '/me/player/volume', { query: { volume_percent: percent } }),
  shuffle: (state) => request('PUT', '/me/player/shuffle', { query: { state } }),
  current: () => request('GET', '/me/player/currently-playing'),
  devices: () => request('GET', '/me/player/devices'),
  transfer: (deviceId) => request('PUT', '/me/player', { body: { device_ids: [deviceId], play: true } }),
  search: (q, type = 'track', limit = 5) => request('GET', '/search', { query: { q, type, limit } }),
};
