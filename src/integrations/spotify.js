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

async function request(method, endpoint, { body, query } = {}) {
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
  if (res.status === 404) throw new Error('Nenhum dispositivo Spotify ativo. Abra o Spotify e toque algo uma vez.');
  if (!res.ok) throw new Error(`Spotify ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
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
