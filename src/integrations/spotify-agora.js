import { spotify, isConfigured } from './spotify.js';
import { writeRuntime } from '../core/state.js';

/**
 * "Tocando agora" ao vivo pro HUD.
 *
 * A skill do Spotify so responde quando alguem PERGUNTA — o painel precisa da
 * musica atual sem ninguem pedir. Este poll pergunta ao Spotify de tempos em
 * tempos e escreve em `runtime.nowPlaying`, que o snapshot ja expoe e o HUD ja
 * sabe desenhar.
 *
 * Duas decisoes que importam:
 *
 * 1. **So grava quando MUDA.** Escrever a cada volta seria uma escrita em disco
 *    a cada poucos segundos — e no Raspberry isso e o cartao SD morrendo de
 *    escrita. Entao comparamos faixa/artista/estado e so gravamos na troca.
 *
 * 2. **O progresso nao entra nessa conta.** Ele muda o tempo todo; grava-lo
 *    obrigaria a escrever sempre. Guardamos `progressMs` + `at` (o instante da
 *    leitura) e o HUD extrapola o ponteiro sozinho — barato e continuo.
 */

const INTERVALO_PADRAO = Number(process.env.SPOTIFY_POLL_MS || 6000);

function resumir(data) {
  const item = data?.item;
  if (!item) return null;
  const imagens = item.album?.images || [];
  return {
    title: item.name,
    artist: (item.artists || []).map((a) => a.name).join(', '),
    album: item.album?.name || null,
    // A do meio, nao a maior: o painel desenha pequeno, e baixar 640x640 a cada
    // troca de faixa e peso a toa numa tela de 7 polegadas.
    art: (imagens[1] || imagens[0])?.url || null,
    isPlaying: Boolean(data.is_playing),
    progressMs: data.progress_ms ?? null,
    durationMs: item.duration_ms ?? null,
    at: Date.now(),
  };
}

/** O que decide se houve mudanca de verdade — progresso de proposito fora. */
function assinatura(np) {
  return np ? `${np.title}|${np.artist}|${np.isPlaying}` : 'nada';
}

/**
 * Comeca a acompanhar. Devolve { stop() }.
 *
 * Roda no HUD e no nucleus: os dois leem o MESMO runtime, entao qualquer um que
 * escreva ja serve aos dois. Deixar os dois perguntando custa uma requisicao a
 * mais por ciclo (folgado no limite do Spotify) e evita eleger um dono — que
 * quebraria justamente quando o dono nao estivesse de pe.
 */
export function acompanharSpotify({ intervaloMs = INTERVALO_PADRAO } = {}) {
  let ultima = null; // assinatura do que ja foi gravado por este processo
  let parado = false;

  const olhar = async () => {
    if (parado || !isConfigured()) return;
    let atual;
    try {
      atual = resumir(await spotify.current());
    } catch {
      // Token renovando, rede oscilando, nenhum aparelho ativo: mantem o ultimo
      // conhecido na tela. Apagar a faixa por causa de uma requisicao ruim seria
      // pior que mostrar o que tocava ha cinco segundos.
      return;
    }
    const agora = assinatura(atual);
    if (agora === ultima) return; // nada mudou — nao toca no disco
    ultima = agora;
    writeRuntime({ nowPlaying: atual });
  };

  olhar();
  const timer = setInterval(olhar, intervaloMs);
  return {
    stop() {
      parado = true;
      clearInterval(timer);
    },
  };
}
