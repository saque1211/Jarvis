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

// O Pi manda WAV; o navegador manda webm/opus (ou mp4 no Safari). O Groq aceita
// os dois — o que ele precisa e o nome do arquivo com a extensao certa e o
// content-type batendo. Sem isto, o audio do navegador viraria "wav" torto e
// a transcricao voltaria vazia sem dizer por que.
function extDoTipo(tipo) {
  if (tipo.includes('webm')) return 'webm';
  if (tipo.includes('ogg')) return 'ogg';
  if (tipo.includes('mp4') || tipo.includes('m4a') || tipo.includes('aac')) return 'm4a';
  if (tipo.includes('mpeg') || tipo.includes('mp3')) return 'mp3';
  return 'wav';
}

/**
 * @param {Buffer} audio  bytes do audio (WAV do Pi, webm/mp4 do navegador)
 * @param {string} vocabulario  nomes proprios que o modelo deve esperar ouvir
 * @param {string} tipo  content-type do audio; decide a extensao mandada ao Groq
 */
export async function transcreverNaNuvem(audio, vocabulario = null, tipo = 'audio/wav') {
  const chave = process.env.GROQ_API_KEY;
  if (!chave) {
    throw new Error(
      'Falta GROQ_API_KEY pra transcrever. O Whisper do Groq e gratuito — ' +
        'pegue em console.groq.com/keys.'
    );
  }

  const limpo = String(tipo || 'audio/wav').split(';')[0].trim() || 'audio/wav';
  const form = new FormData();
  form.append('file', new Blob([audio], { type: limpo }), `comando.${extDoTipo(limpo)}`);
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
