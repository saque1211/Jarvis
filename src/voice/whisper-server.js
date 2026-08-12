import fs from 'node:fs';
import { config } from '../core/config.js';
import { startBackground } from '../platform/win32.js';

/**
 * Sobe o whisper-server junto com o daemon, quando ele nao estiver no ar.
 *
 * Existia so como `npm run whisper:server` numa segunda janela. Isso funciona,
 * mas transforma "esqueci de abrir a outra janela" numa transcricao dez vezes
 * mais lenta, sem nada na tela explicando por que.
 */

let processo = null;

/** Deduz binario e modelo do STT_COMMAND, pra ninguem configurar duas vezes. */
function deduzir() {
  const comando = config.voice.sttCommand;
  if (!comando) return {};

  const tokens = (comando.match(/"([^"]*)"|(\S+)/g) || []).map((t) => t.replace(/"/g, ''));
  const modelo = tokens[tokens.indexOf('-m') + 1] || tokens[tokens.indexOf('--model') + 1];
  const cli = tokens.find((t) => /whisper-cli(\.exe)?$/i.test(t));
  const bin = cli ? cli.replace(/whisper-cli(\.exe)?$/i, 'whisper-server$1') : null;

  return { bin, modelo };
}

/**
 * "Alguem responde nessa porta?" nao basta. A 8080 e a porta mais disputada de
 * qualquer maquina de desenvolvimento — outro programa ali aceita a conexao,
 * nunca responde ao /inference, e a transcricao trava esperando.
 *
 * Devolve 'whisper', 'outro' ou 'nada'.
 */
async function quemAtende(url, timeoutMs = 2000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const corpo = await res.text().catch(() => '');
    return /whisper/i.test(corpo) ? 'whisper' : 'outro';
  } catch {
    return 'nada';
  }
}

/**
 * Devolve uma frase do que aconteceu, pro daemon logar. Nunca lanca: falhar em
 * subir o servidor e perda de velocidade, nao de funcao — o STT_COMMAND
 * assume.
 */
export async function ensureWhisperServer() {
  const url = config.voice.sttServerUrl;
  if (!url) return null;

  const quem = await quemAtende(url);
  if (quem === 'whisper') return 'ja estava no ar';
  if (quem === 'outro') {
    const porta = new URL(url).port || '80';
    return (
      `a porta ${porta} esta ocupada por outro programa, nao pelo whisper — ` +
      `troque a porta no STT_SERVER_URL (ex: http://127.0.0.1:8422) ou tire a ` +
      `variavel do .env pra usar so o STT_COMMAND`
    );
  }

  const { bin, modelo } = deduzir();
  if (!bin || !modelo) {
    return 'nao consegui deduzir o binario do STT_COMMAND — suba com npm run whisper:server';
  }
  if (!fs.existsSync(bin)) return `nao achei ${bin}`;
  if (!fs.existsSync(modelo)) return `nao achei o modelo ${modelo}`;

  const porta = new URL(url).port || '8080';
  processo = startBackground(bin, ['-m', modelo, '-l', 'pt', '--port', porta]);

  // Carregar o modelo leva alguns segundos; espera ele atender antes de dizer
  // que subiu, senao a primeira frase falada cai na reserva lenta.
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if ((await quemAtende(url)) === 'whisper') return `subi na porta ${porta}`;
  }

  processo?.stop();
  processo = null;
  return 'subiu mas nao respondeu em 20s — seguindo com o STT_COMMAND';
}

export function stopWhisperServer() {
  processo?.stop();
  processo = null;
}
