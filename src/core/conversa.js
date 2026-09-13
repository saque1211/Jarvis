import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

/**
 * Memoria curta da conversa.
 *
 * O roteador sempre comecou do zero a cada comando. Isso funciona pra "toca
 * musica", mas quebra na hora em que o assistente PERGUNTA:
 *
 *   voce: aumenta o volume
 *   VEXIS: Preciso saber em quanto. E 0 a 100, qual numero?
 *   voce: 25
 *   VEXIS: Opa, so um numero? Preciso saber o que voce quer fazer.
 *
 * A resposta chega num processo novo, sem lembrar a pergunta. Aqui ficam as
 * ultimas trocas pra que "25" continue querendo dizer volume.
 *
 * Tres escolhas que importam:
 *
 * 1. **So texto.** Guardamos o que a pessoa disse e o que foi respondido —
 *    nunca as tool_use e os tool_result do meio. Eles sao grandes, tem id que
 *    so vale dentro daquela chamada, e nao e deles que "25" precisa.
 *
 * 2. **Vence rapido.** Passados poucos minutos, "25" nao e mais resposta de
 *    pergunta nenhuma; e um comando solto que merece comecar limpo. Historico
 *    velho atrapalha mais do que ajuda — o modelo tenta encaixar o novo pedido
 *    no assunto de meia hora atras.
 *
 * 3. **Separado por origem.** A voz da sala e o app do celular sao conversas
 *    diferentes acontecendo ao mesmo tempo. Misturar as duas faria o painel
 *    responder no meio do que alguem digitou no telefone.
 */

const ARQUIVO = () => path.join(config.vaultPath, 'conversa.json');

/** Quantas trocas (pergunta + resposta) sobrevivem. */
const TROCAS = Number(process.env.JARVIS_CONVERSA_TROCAS || 3);

/** Depois disso, comeca do zero. */
const VALIDADE_MS = Number(process.env.JARVIS_CONVERSA_MINUTOS || 5) * 60 * 1000;

function ler() {
  try {
    return JSON.parse(fs.readFileSync(ARQUIVO(), 'utf8'));
  } catch {
    return {};
  }
}

/**
 * As ultimas trocas daquela origem, no formato canonico do llm.js. Devolve
 * lista vazia quando nao ha nada recente — que e o comportamento de sempre.
 */
export function lembrar(origem = 'cli') {
  if (TROCAS <= 0) return [];
  const linha = ler()[origem];
  if (!linha?.trocas?.length) return [];
  if (Date.now() - (linha.em || 0) > VALIDADE_MS) return [];

  const msgs = [];
  for (const t of linha.trocas.slice(-TROCAS)) {
    msgs.push({ role: 'user', content: t.voce });
    msgs.push({ role: 'assistant', text: t.vexis });
  }
  return msgs;
}

/** Guarda a troca que acabou de acontecer. */
export function guardar(origem, voce, vexis) {
  if (TROCAS <= 0) return;
  if (!voce || !vexis) return;

  const tudo = ler();
  const anterior = tudo[origem];
  // Conversa vencida nao vira base pra proxima: se a anterior expirou, esta
  // troca comeca uma nova em vez de emendar num assunto que ja morreu.
  const vivas =
    anterior && Date.now() - (anterior.em || 0) <= VALIDADE_MS ? anterior.trocas || [] : [];

  tudo[origem] = {
    em: Date.now(),
    // Uma resposta longa nao ajuda a entender o "25" e ainda paga token em
    // toda chamada seguinte.
    trocas: [...vivas, { voce: String(voce).slice(0, 500), vexis: String(vexis).slice(0, 500) }]
      .slice(-TROCAS),
  };

  try {
    fs.mkdirSync(config.vaultPath, { recursive: true });
    fs.writeFileSync(ARQUIVO(), JSON.stringify(tudo));
  } catch {
    // Cartao cheio ou so-leitura: perder a memoria curta e muito melhor que
    // derrubar o comando que acabou de funcionar.
  }
}

/** Zera a conversa de uma origem — usado quando alguem pede pra esquecer. */
export function esquecer(origem = 'cli') {
  const tudo = ler();
  delete tudo[origem];
  try {
    fs.writeFileSync(ARQUIVO(), JSON.stringify(tudo));
  } catch {
    // Idem.
  }
}
