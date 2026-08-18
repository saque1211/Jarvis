import { config } from '../core/config.js';

/**
 * Transcricao na nuvem.
 *
 * Existe porque o Pi Zero 2 W tem 512 MB de RAM e o modelo `small` do whisper
 * ocupa 488 MB so pra carregar — nao cabe, e o `tiny` que caberia erra demais
 * em portugues. Entao o audio sobe.
 *
 * O Groq serve o Whisper large-v3-turbo de graca e mais rapido que tempo real,
 * o que torna essa troca barata: perde-se o "audio nunca sai da maquina", que
 * era uma propriedade real da versao Windows, e ganha-se transcricao melhor do
 * que a que rodava localmente.
 */

// Sobrescrivel pra teste apontar num servidor falso — sem isso, provar que o
// tratamento de erro funciona exigiria queimar cota de verdade.
const ENDPOINT = process.env.JARVIS_STT_URL || 'https://api.groq.com/openai/v1/audio/transcriptions';

// turbo: mesma familia do large-v3, varias vezes mais rapido. Pra comando de
// voz curto a diferenca de qualidade nao aparece e a de latencia aparece muito.
const MODELO = process.env.JARVIS_STT_MODELO || 'whisper-large-v3-turbo';

/**
 * @param {Buffer} wav  audio 16 kHz mono
 * @param {string} vocabulario  nomes proprios que o modelo deve esperar ouvir
 */
export async function transcreverNaNuvem(wav, vocabulario = null) {
  const chave = process.env.GROQ_API_KEY;
  if (!chave) {
    throw new Error(
      'Falta GROQ_API_KEY pra transcrever. O Whisper do Groq e gratuito — ' +
        'pegue em console.groq.com/keys.'
    );
  }

  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'comando.wav');
  form.append('model', MODELO);
  form.append('language', 'pt');
  form.append('response_format', 'json');
  // Mesmo papel do prompt inicial na versao local: desempata palavra parecida.
  if (vocabulario) form.append('prompt', vocabulario);

  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${chave}` },
      body: form,
      // Audio de comando tem segundos. Passou disso, travou.
      signal: AbortSignal.timeout(Number(process.env.JARVIS_STT_TIMEOUT_MS || 20000)),
    });
  } catch (err) {
    const motivo = err.name === 'TimeoutError' ? 'demorou demais' : err.message;
    throw new Error(`Nao consegui falar com o servico de transcricao (${motivo}).`);
  }

  if (!res.ok) {
    const corpo = await res.text();
    if (res.status === 401) throw new Error('GROQ_API_KEY invalida ou revogada.');
    if (res.status === 429) throw new Error('Limite de transcricao do Groq atingido. Tente em instantes.');
    throw new Error(`Transcricao falhou (HTTP ${res.status}): ${corpo.slice(0, 200)}`);
  }

  const { text } = await res.json();
  return (text || '').trim() || null;
}
