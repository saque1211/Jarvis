import { spotify, isConfigured } from '../integrations/spotify.js';

/**
 * Abaixa a musica enquanto o assistente fala, e devolve o volume depois.
 *
 * Sem isto a resposta sai POR CIMA da musica e nao se entende nada — foi o
 * primeiro defeito que apareceu assim que o Spotify comecou a tocar no proprio
 * painel. Nao da pra resolver mexendo no volume do ALSA: ali a fala e a musica
 * ja estao misturadas, e abaixar uma abaixaria as duas.
 *
 * Por isso o corte e no volume do APARELHO do Spotify, pela API. A fala sai
 * inteira, a musica recua, e ninguem perde o fio.
 *
 * E comeca ANTES da resposta: assim que o painel acorda. Com a caixa tocando
 * alto no mesmo comodo, o microfone grava a musica junto com o comando, e a
 * transcricao sai com pedaco de letra no meio — o assistente entao responde
 * uma pergunta que ninguem fez. Abaixar enquanto ele ouve conserta a entrada;
 * abaixar enquanto ele fala conserta a saida. Sao dois problemas.
 *
 * Duas armadilhas que o codigo evita de proposito:
 *
 * 1. **Guardar o volume ja abaixado.** Duas respostas seguidas: a segunda
 *    anotaria 20% como "o volume de antes" e a musica nunca mais voltaria ao
 *    que era. Por isso o original so e anotado quando nao ha um abafamento em
 *    curso.
 *
 * 2. **Restaurar cedo demais.** O relogio comeca quando os bytes SAEM daqui,
 *    mas quem toca e o Pi, um instante depois. A margem cobre essa viagem.
 */

const LIGADO = process.env.JARVIS_ABAFAR !== '0';
const FATOR = Number(process.env.JARVIS_ABAFAR_FATOR || 0.25);
const MARGEM_MS = Number(process.env.JARVIS_ABAFAR_MARGEM || 700);

let volumeOriginal = null; // volume de antes; null = nao ha abafamento em curso
let timer = null;

/**
 * Duracao aproximada do audio, em ms.
 *
 * WAV diz a verdade no cabecalho. MP3 (ElevenLabs) exigiria varrer frames, e
 * nao vale o trabalho: um palpite por taxa media erra por decimos de segundo, e
 * a margem cobre o erro. Melhor um numero aproximado agora que um exato caro.
 */
export function duracaoAproximada(bytes) {
  if (!bytes?.length) return 0;

  if (bytes.length > 44 && bytes.toString('ascii', 0, 4) === 'RIFF') {
    try {
      const byteRate = bytes.readUInt32LE(28);
      if (byteRate > 0) {
        // O trecho de dados e o arquivo menos o cabecalho; 44 bytes e o WAV
        // canonico, que e o que os nossos sintetizadores geram.
        return Math.round(((bytes.length - 44) / byteRate) * 1000);
      }
    } catch {
      // Cabecalho torto: cai no palpite abaixo.
    }
  }
  // ~128 kbps = 16 bytes por milissegundo.
  return Math.round(bytes.length / 16);
}

async function volumeAtual() {
  const data = await spotify.devices();
  const ativo = (data?.devices || []).find((d) => d.is_active);
  if (!ativo || typeof ativo.volume_percent !== 'number') return null;
  return ativo.volume_percent;
}

/**
 * Abaixa agora e agenda a volta daqui a `duracaoMs`.
 *
 * Chamar de novo durante um abafamento ESTENDE o prazo em vez de comecar
 * outro: e o que liga "ele acordou" a "ele respondeu" num periodo so, sem a
 * musica dar um pulo de volume no meio.
 *
 * Nunca lanca: falhar aqui nao pode calar o assistente.
 */
export async function abafar(duracaoMs) {
  if (!LIGADO || !isConfigured() || !duracaoMs) return;

  try {
    // So mexe se houver musica TOCANDO. Abaixar o volume de um Spotify pausado
    // deixaria uma surpresa pra proxima vez que a pessoa desse play.
    const tocando = await spotify.current();
    if (!tocando?.is_playing) return;

    if (volumeOriginal == null) {
      const atual = await volumeAtual();
      if (atual == null || atual === 0) return;
      volumeOriginal = atual;
    }

    const baixo = Math.max(5, Math.round(volumeOriginal * FATOR));
    if (baixo < volumeOriginal) await spotify.setVolume(baixo);

    // Uma fala nova durante a anterior estende o abafamento em vez de criar um
    // segundo relogio — dois timers devolveriam o volume no meio da segunda.
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      timer = null;
      const voltar = volumeOriginal;
      volumeOriginal = null;
      if (voltar != null) {
        try {
          await spotify.setVolume(voltar);
        } catch {
          // Aparelho sumiu no meio: o volume volta sozinho quando ele reaparece.
        }
      }
    }, duracaoMs + MARGEM_MS);
    timer.unref?.();
  } catch {
    // Spotify fora do ar, token renovando, sem aparelho: a fala sai do mesmo
    // jeito. Abafar e conforto, nao requisito.
  }
}

/** Nome antigo, mantido porque le melhor no ponto da resposta falada. */
export const abafarEnquantoFala = abafar;
