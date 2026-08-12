#!/usr/bin/env node
import fs from 'node:fs';
import crypto from 'node:crypto';
import pc from 'picocolors';
import { ps, psQuote } from '../src/platform/win32.js';

/**
 * Lista as vozes neurais da Microsoft e fala uma frase com cada uma.
 *
 * Escolher voz pelo nome e chute; ouvindo leva um minuto e resolve.
 */

const TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const FRASE = 'Oi, eu sou o Jarvis. Posso falar com esta voz.';

function gerarToken() {
  const EPOCA_WINDOWS = 11644473600;
  let segundos = Math.floor(Date.now() / 1000) + EPOCA_WINDOWS;
  segundos -= segundos % 300;
  return crypto.createHash('sha256').update(`${segundos * 1e7}${TOKEN}`).digest('hex').toUpperCase();
}

const idioma = (process.argv[2] || 'pt-BR').toLowerCase();
const ouvir = !process.argv.includes('--mudo');

console.log(pc.bold(pc.cyan('\n  Vozes neurais da Microsoft (gratuitas, sem chave)\n')));

let lista;
try {
  const res = await fetch(
    `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list` +
      `?trustedclienttoken=${TOKEN}&Sec-MS-GEC=${gerarToken()}&Sec-MS-GEC-Version=1-130.0.0.0`,
    {
      headers: {
        Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0.0.0 Edg/130.0.0.0',
      },
      signal: AbortSignal.timeout(20000),
    }
  );
  if (!res.ok) throw new Error(`servico respondeu ${res.status}`);
  lista = await res.json();
} catch (err) {
  console.error(pc.red(`  Nao consegui buscar a lista: ${err.message}\n`));
  console.error(pc.dim('  Sem internet o Edge TTS nao funciona mesmo — ele sintetiza na nuvem.'));
  console.error(pc.dim('  Pra voz offline, use o Piper: npm run voice:piper --lista\n'));
  process.exit(1);
}

const vozes = lista.filter((v) => (v.Locale || '').toLowerCase().startsWith(idioma));

if (!vozes.length) {
  console.error(pc.yellow(`  Nenhuma voz para "${idioma}".`));
  console.error(pc.dim('  Tente pt-BR, pt-PT, en-US, es-ES...\n'));
  process.exit(1);
}

console.log(pc.dim(`  ${vozes.length} voz(es) em ${idioma}\n`));

const { synthesize } = await import('../src/integrations/edge-tts.js');

for (const voz of vozes) {
  const curto = voz.ShortName;
  const genero = voz.Gender === 'Male' ? 'masculina' : 'feminina';
  const personalidades = voz.VoiceTag?.VoicePersonalities?.join(', ') || '';

  console.log(`  ${pc.bold(curto)} ${pc.dim(`(${genero}${personalidades ? `, ${personalidades}` : ''})`)}`);

  if (!ouvir) continue;

  try {
    const wav = await synthesize(FRASE, { voice: curto });
    await ps(`(New-Object System.Media.SoundPlayer ${psQuote(wav)}).PlaySync()`, {
      timeoutMs: 60000,
    });
    fs.rmSync(wav, { force: true });
  } catch (err) {
    console.log(pc.red(`    falhou: ${err.message}`));
  }
}

console.log(pc.bold('\n  Escolheu? Ponha no .env:'));
console.log(pc.green(`    EDGE_TTS_VOICE=${vozes[0].ShortName}\n`));
console.log(pc.dim('  Ajuste fino: EDGE_TTS_RATE=-10% deixa mais lenta,'));
console.log(pc.dim('  EDGE_TTS_VOLUME=+20% mais alta.\n'));
console.log(pc.dim('  Precisa de internet — sem ela, a fala cai no TTS local.\n'));
