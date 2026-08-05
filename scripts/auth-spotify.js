#!/usr/bin/env node
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { config } from '../src/core/config.js';
import { saveTokens, SCOPES } from '../src/integrations/spotify.js';

/**
 * Autorizacao unica do Spotify (Authorization Code + PKCE).
 * Sobe um servidor local no 8888, abre o navegador, captura o code e troca
 * por tokens. Depois disso o JARVIS renova sozinho pra sempre.
 *
 * No dashboard do Spotify, cadastre o Redirect URI: http://127.0.0.1:8888/callback
 */

const PORT = 8888;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;

if (!config.spotify.clientId) {
  console.error('Falta SPOTIFY_CLIENT_ID no .env.');
  console.error('Crie um app em https://developer.spotify.com/dashboard');
  console.error(`E cadastre o Redirect URI: ${REDIRECT_URI}`);
  process.exit(1);
}

const verifier = crypto.randomBytes(48).toString('base64url');
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
const state = crypto.randomBytes(16).toString('hex');

const authUrl = new URL('https://accounts.spotify.com/authorize');
authUrl.searchParams.set('client_id', config.spotify.clientId);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
authUrl.searchParams.set('scope', SCOPES);
authUrl.searchParams.set('code_challenge_method', 'S256');
authUrl.searchParams.set('code_challenge', challenge);
authUrl.searchParams.set('state', state);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname !== '/callback') {
    res.writeHead(404).end();
    return;
  }

  const code = url.searchParams.get('code');
  const returnedState = url.searchParams.get('state');

  if (returnedState !== state) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>State invalido. Tente de novo.</h1>');
    server.close();
    process.exit(1);
  }

  if (!code) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<h1>Autorizacao negada.</h1><p>${url.searchParams.get('error') || ''}</p>`);
    server.close();
    process.exit(1);
  }

  try {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: config.spotify.clientId,
      code_verifier: verifier,
    });
    if (config.spotify.clientSecret) body.set('client_secret', config.spotify.clientSecret);

    const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!tokenRes.ok) throw new Error(`${tokenRes.status} ${await tokenRes.text()}`);

    saveTokens(await tokenRes.json());

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>JARVIS conectado ao Spotify.</h1><p>Pode fechar esta aba.</p>');
    console.log(`\nTokens salvos em ${config.spotify.tokenFile}`);
    console.log('Teste com: npm run jarvis "toca alguma coisa no spotify"');
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<h1>Falha ao trocar o code</h1><pre>${err.message}</pre>`);
    console.error(err.message);
  }

  server.close();
  setTimeout(() => process.exit(0), 300);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Abrindo o navegador para autorizar...\n${authUrl}\n`);
  const opener =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', authUrl.toString()]]
    : process.platform === 'darwin' ? ['open', [authUrl.toString()]]
    : ['xdg-open', [authUrl.toString()]];
  spawn(opener[0], opener[1], { detached: true, stdio: 'ignore' }).unref();
});
