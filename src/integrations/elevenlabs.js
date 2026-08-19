import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../core/config.js';

/**
 * ElevenLabs — a voz mais natural que existe em pt-BR hoje.
 *
 * Custa ~10x os outros provedores, e a troca vale porque a voz e a unica parte
 * do assistente que voce ouve o dia inteiro. O resto do sistema ja trata voz de
 * nuvem como opcional: falhando, a cadeia cai no proximo provedor e a fala sai
 * do mesmo jeito — mudo por causa de API fora do ar seria pior que voz feia.
 */

const BASE = process.env.ELEVENLABS_BASE_URL || 'https://api.elevenlabs.io/v1';

export function isConfigured() {
  return Boolean(config.elevenLabs.apiKey && config.elevenLabs.voiceId);
}

/**
 * Descreve a chave sem revelar: tamanho e prefixo bastam pra reconhecer os
 * erros de colagem, que sao a causa mais comum de "invalida". Imprimir a chave
 * inteira num diagnostico e como pedir pra ela vazar num print.
 */
export function formatoDaChave() {
  const k = config.elevenLabs.apiKey;
  if (!k) return 'ausente';

  const pistas = [`${k.length} caracteres`];
  if (k.startsWith('sk_')) pistas.push('prefixo sk_ (formato atual)');
  else if (/^[0-9a-f]{32}$/i.test(k)) pistas.push('formato antigo, 32 hex');
  else pistas.push(`comeca com "${k.slice(0, 3)}"`);

  // Erros de colagem que passam despercebidos porque a chave "parece" certa.
  if (/\s/.test(k)) pistas.push('CONTEM ESPACO — colagem quebrada');
  if (/^["']|["']$/.test(k)) pistas.push('CONTEM ASPAS — tire do .env');
  if (k.length < 20) pistas.push('CURTA DEMAIS — parece cortada');

  // ID de voz tem exatamente 20 alfanumericos. Trocar um pelo outro e facil:
  // as duas coisas sao "aquele codigo do ElevenLabs" e ficam em paginas
  // diferentes do site. Sem apontar isso, a pessoa procura problema na chave
  // certa e nunca acha.
  if (parecerIdDeVoz(k)) {
    pistas.push('ISTO PARECE UM ID DE VOZ, nao uma chave — vai em ELEVENLABS_VOICE_ID');
  }

  return pistas.join(', ');
}

/** ID de voz: 20 alfanumericos, sem prefixo. Chave tem 51 e comeca com sk_. */
export function parecerIdDeVoz(valor) {
  return /^[A-Za-z0-9]{20}$/.test(String(valor || ''));
}

/**
 * Sintetiza e devolve os BYTES. O formato vem do provedor: MP3 por padrao,
 * porque e o unico disponivel em todos os planos deles — PCM e reservado aos
 * pagos mais caros, e escolher PCM por padrao quebraria pra quem assina o
 * plano de entrada.
 */
export async function sintetizarBytes(texto) {
  const { apiKey, voiceId, modelo, formato, estabilidade, similaridade, estilo } =
    config.elevenLabs;

  if (!apiKey) throw new Error('Falta ELEVENLABS_API_KEY no .env.');
  if (!voiceId) throw new Error('Falta ELEVENLABS_VOICE_ID no .env — veja: npm run voices:eleven');

  const url = `${BASE}/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${formato}`;

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'content-type': 'application/json',
        accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text: texto,
        model_id: modelo,
        voice_settings: {
          // Estabilidade alta deixa a leitura previsivel; baixa deixa
          // expressiva e as vezes esquisita. Pra assistente, previsivel ganha.
          stability: estabilidade,
          similarity_boost: similaridade,
          style: estilo,
          use_speaker_boost: true,
        },
      }),
      // Resposta de assistente e curta; passando disso, travou.
      signal: AbortSignal.timeout(Number(process.env.ELEVENLABS_TIMEOUT_MS || 20000)),
    });
  } catch (err) {
    const motivo = err.name === 'TimeoutError' ? 'demorou demais' : err.message;
    throw new Error(`Nao alcancei o ElevenLabs (${motivo}).`);
  }

  if (!res.ok) {
    const corpo = await res.text();
    if (res.status === 401) {
      throw new Error(
        `ELEVENLABS_API_KEY invalida ou revogada (a do .env tem ${formatoDaChave()}). ` +
          'Os dois formatos deles valem: 32 caracteres hexadecimais (antigo) ou ' +
          '"sk_" com 51 (atual). Gere outra em elevenlabs.io/app/settings/api-keys.'
      );
    }
    if (res.status === 404) {
      throw new Error(
        `Voz "${voiceId}" nao existe nessa conta. Veja as suas com: npm run voices:eleven`
      );
    }
    if (res.status === 429) throw new Error('Limite do ElevenLabs atingido — cota do mes ou requisicoes simultaneas.');
    // 402 e o mais provavel de aparecer no uso normal: cota do mes acabou.
    if (res.status === 402) {
      throw new Error('Cota de caracteres do ElevenLabs esgotada neste mes.');
    }
    throw new Error(`ElevenLabs respondeu ${res.status}: ${corpo.slice(0, 200)}`);
  }

  return Buffer.from(await res.arrayBuffer());
}

/**
 * Mesmo contrato dos outros provedores da cadeia do Windows: devolve o CAMINHO
 * de um arquivo. O `playWav` fareja o cabecalho e escolhe o player, entao MP3
 * daqui toca sem tratamento especial.
 */
export async function synthesize(texto) {
  const bytes = await sintetizarBytes(texto);
  const ext = config.elevenLabs.formato.startsWith('mp3') ? 'mp3' : 'wav';
  const arquivo = path.join(os.tmpdir(), `vexis-11l-${Date.now()}.${ext}`);
  fs.writeFileSync(arquivo, bytes);
  return arquivo;
}

/** As vozes da conta, pra escolher o ID sem caçar no site. */
export async function listarVozes() {
  const { apiKey } = config.elevenLabs;
  if (!apiKey) throw new Error('Falta ELEVENLABS_API_KEY no .env.');

  const res = await fetch(`${BASE}/voices`, {
    headers: { 'xi-api-key': apiKey },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    if (res.status === 401) {
      throw new Error(
        `ELEVENLABS_API_KEY invalida ou revogada (a do .env tem ${formatoDaChave()}). ` +
          'Valem os dois formatos: 32 hexadecimais (antigo) ou "sk_" com 51 (atual).'
      );
    }
    throw new Error(`ElevenLabs respondeu ${res.status}`);
  }

  const { voices } = await res.json();
  return (voices || []).map((v) => ({
    id: v.voice_id,
    nome: v.name,
    // As vozes nao sao marcadas por idioma: os modelos multilingues falam
    // qualquer uma em portugues. O rotulo aqui e so a descricao da propria voz.
    descricao: [v.labels?.gender, v.labels?.age, v.labels?.accent, v.labels?.description]
      .filter(Boolean)
      .join(', '),
    categoria: v.category,
  }));
}

/** Quanto ainda cabe na cota do mes. */
export async function cota() {
  const { apiKey } = config.elevenLabs;
  if (!apiKey) return null;
  try {
    const res = await fetch(`${BASE}/user/subscription`, {
      headers: { 'xi-api-key': apiKey },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const d = await res.json();
    return {
      usados: d.character_count,
      limite: d.character_limit,
      plano: d.tier,
      renovaEm: d.next_character_count_reset_unix
        ? new Date(d.next_character_count_reset_unix * 1000).toISOString()
        : null,
    };
  } catch {
    return null;
  }
}
