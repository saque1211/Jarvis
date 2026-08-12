import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { config } from '../core/config.js';

/**
 * Fish Audio — TTS na nuvem.
 *
 * Diferente do Piper, a voz nao mora aqui: voce guarda um reference_id e o
 * audio e sintetizado no servidor deles. Em troca da qualidade, o texto da
 * resposta sai da sua maquina e cada fala custa uma ida a rede.
 *
 * O audio do microfone continua nunca saindo — isso nao muda.
 */

const ENDPOINT = 'https://api.fish.audio/v1/tts';

export function isConfigured() {
  return Boolean(config.fishAudio.apiKey && config.fishAudio.voiceId);
}

/**
 * Sintetiza e devolve o caminho de um WAV. Quem chama decide se toca no PC ou
 * manda pro celular.
 */
export async function synthesize(text) {
  const { apiKey, voiceId, model } = config.fishAudio;

  if (!apiKey) throw new Error('Falta FISH_AUDIO_API_KEY no .env.');
  if (!voiceId) throw new Error('Falta FISH_AUDIO_VOICE_ID no .env.');

  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        // Qual motor de sintese usar. Eles versionam por header, nao no corpo.
        model,
      },
      body: JSON.stringify({
        text,
        reference_id: voiceId,
        format: 'wav',
        // "normalize" arruma numero e abreviacao antes de falar — "10" vira
        // "dez". Sem isso a leitura sai estranha em resposta com numero.
        normalize: true,
        latency: 'normal',
      }),
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    throw new Error(
      `Nao alcancei o Fish Audio: ${err.message}\n` +
        'Sem internet, a fala cai pro TTS local automaticamente.'
    );
  }

  if (!response.ok) {
    const detalhe = (await response.text().catch(() => '')).slice(0, 300);
    if (response.status === 401 || response.status === 403) {
      throw new Error('FISH_AUDIO_API_KEY invalida ou sem credito. Confira em fish.audio.');
    }
    if (response.status === 404) {
      throw new Error(
        `Voz "${voiceId}" nao encontrada. Confira o FISH_AUDIO_VOICE_ID — ` +
          'ele e o reference_id que aparece na pagina da voz.'
      );
    }
    if (response.status === 402 || response.status === 429) {
      throw new Error('Fish Audio recusou por limite ou credito acabado.');
    }
    throw new Error(`Fish Audio respondeu ${response.status}: ${detalhe}`);
  }

  const audio = Buffer.from(await response.arrayBuffer());
  if (audio.length < 100) throw new Error('Fish Audio devolveu audio vazio.');

  const out = path.join(os.tmpdir(), `jarvis-fish-${Date.now()}.wav`);
  fs.writeFileSync(out, audio);
  return out;
}
