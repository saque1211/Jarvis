import { config } from '../core/config.js';

/**
 * Reconhecer a palavra de ativacao no que o Whisper transcreveu.
 *
 * O Porcupine so tem palavras prontas — "jarvis", "alexa", "computer" — e
 * "vexis" exigiria treinar um modelo no console deles. Como o Whisper ja esta
 * carregado na maquina, da pra usar ele como detector: transcreve o pedacinho
 * de fala e pergunta "isso soou como vexis?".
 *
 * A vantagem nao e so evitar o cadastro. E que aqui EU controlo a tolerancia,
 * e "vexis" e um nome que o Whisper erra de dez jeitos diferentes: "vexes",
 * "Vex is", "bexis", "véxis", "vecsis". Uma comparacao exata pegaria um em
 * dez. A comparacao e por SOM, e a distancia aceita e um numero no .env.
 */

/**
 * Reduz a palavra ao som, nao a grafia.
 *
 * As trocas sao as que o portugues falado realmente confunde:
 *   x → ks   "vexis" e "vecsis" e "veksis" viram a mesma coisa
 *   c → k    idem
 *   z → s    "vexiz" tambem
 *   b → v    o par que mais some na transcricao de audio ruim
 * e letras repetidas colapsam, porque "vexxis" nao soa diferente.
 */
export function fonetizar(palavra) {
  return String(palavra)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '')
    .replace(/x/g, 'ks')
    .replace(/c/g, 'k')
    .replace(/z/g, 's')
    .replace(/b/g, 'v')
    .replace(/(.)\1+/g, '$1');
}

/** Distancia de edicao, com corte: acima do teto nao interessa o valor exato. */
export function distancia(a, b, teto = Infinity) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > teto) return teto + 1;

  let anterior = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const atual = [i];
    let menor = i;
    for (let j = 1; j <= b.length; j++) {
      atual[j] = Math.min(
        anterior[j] + 1,
        atual[j - 1] + 1,
        anterior[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      if (atual[j] < menor) menor = atual[j];
    }
    // Linha inteira acima do teto: nenhuma continuacao melhora.
    if (menor > teto) return teto + 1;
    anterior = atual;
  }
  return anterior[b.length];
}

function palavrasDe(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * A frase contem a palavra de ativacao?
 *
 * Devolve tambem o que veio DEPOIS dela. "Vexis, toca musica" numa tirada so
 * ja carrega o comando — mandar a pessoa repetir depois do bipe seria fingir
 * que nao ouviu o que ouviu.
 */
export function casaWake(texto, opcoes = {}) {
  const alvo = fonetizar(opcoes.palavra || config.voice.wakeWord);
  const tolerancia = opcoes.tolerancia ?? config.voice.wakeTolerancia;
  const extras = (opcoes.extras || config.voice.wakeAliases).map(fonetizar).filter(Boolean);
  const alvos = [alvo, ...extras];

  const palavras = palavrasDe(texto);
  if (!palavras.length) return { casou: false };

  // Candidatos: cada palavra sozinha, e cada par de palavras vizinhas coladas.
  // O par existe porque o Whisper PARTE nomes que nao conhece — "Vex is" sao
  // dois tokens que juntos formam a palavra inteira.
  const candidatos = [];
  for (let i = 0; i < palavras.length; i++) {
    candidatos.push({ chave: fonetizar(palavras[i]), inicio: i, fim: i + 1 });
    if (i + 1 < palavras.length) {
      candidatos.push({
        chave: fonetizar(palavras[i] + palavras[i + 1]),
        inicio: i,
        fim: i + 2,
      });
    }
  }

  // Escolhe o MELHOR, nao o primeiro que servir.
  //
  // Em "vex is", a palavra "vex" sozinha ja fica dentro da tolerancia — e o
  // primeiro que serve. Aceitar ela deixaria "is" como comando, e o modelo
  // receberia a metade final do proprio nome pra interpretar. O par colado
  // casa exato; entre os dois, ganha o de menor distancia, e no empate o que
  // consome mais palavras.
  let melhor = null;
  for (const c of candidatos) {
    // Pedaco curto demais casa com qualquer coisa e vira disparo por engano.
    if (c.chave.length < 3) continue;
    for (const a of alvos) {
      const d = distancia(c.chave, a, tolerancia);
      if (d > tolerancia) continue;
      const largura = c.fim - c.inicio;
      if (!melhor || d < melhor.d || (d === melhor.d && largura > melhor.fim - melhor.inicio)) {
        melhor = { ...c, d };
      }
    }
  }

  if (!melhor) return { casou: false };

  const sobra = palavras.slice(melhor.fim).join(' ').trim();
  return {
    casou: true,
    distancia: melhor.d,
    ouviu: palavras.slice(melhor.inicio, melhor.fim).join(' '),
    // Sobra de uma ou duas letras e caco da propria palavra mal partida, nao
    // comando. Mandar isso pro modelo gastaria uma ida pra ele perguntar "o
    // que?" — melhor abrir a escuta normalmente.
    sobra: sobra.length >= 3 ? sobra : '',
  };
}
