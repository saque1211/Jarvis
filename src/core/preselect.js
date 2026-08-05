import { chat } from './llm.js';

/**
 * Pre-selecao de skills.
 *
 * Mandar as 99 tools em toda chamada custa ~14 mil tokens. No free tier do
 * Groq (12 mil tokens por minuto) isso estoura antes de sair do lugar.
 *
 * Entao antes do loop de tool-use existe uma chamada barata, sem tool nenhuma,
 * que so pergunta: "quais skills esse comando precisa?". Dai o loop recebe as
 * tools de duas ou tres skills em vez de todas.
 *
 * Efeito colateral bom: menos opcao pra escolher e menos chance de o modelo
 * chamar a tool errada — que e justamente onde o Llama tropeca.
 */

const MAX_SKILLS = 3;

const SYSTEM = `Voce e o seletor de skills do JARVIS, um assistente que controla um PC Windows.

Dado um comando do usuario, diga quais skills podem ser necessarias pra atender.

Skills disponiveis:
{{SKILLS}}

Responda APENAS com um array JSON de nomes de skill, no maximo ${MAX_SKILLS}.
Exemplos:
  "abre o spotify e poe 25 minutos"  -> ["apps","timer"]
  "quanto de RAM ta livre"           -> ["hardware"]
  "o que eu fiz ontem"               -> ["memory"]

Na duvida entre duas, inclua as duas. Sem explicacao, sem markdown, so o array.`;

function catalog(skills) {
  return skills
    .map((s) => `- ${s.name}: ${s.description} (${s.tools.map((t) => t.name).join(', ')})`)
    .join('\n');
}

/** Aproximacao boa o suficiente pra decidir se vale pre-selecionar. */
export function estimateTokens(tools) {
  const json = JSON.stringify(tools);
  return Math.ceil(json.length / 4);
}

function parseNames(text, valid) {
  const match = text.match(/\[[\s\S]*?\]/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((n) => typeof n === 'string')
      .map((n) => n.trim().toLowerCase())
      .filter((n) => valid.has(n))
      .slice(0, MAX_SKILLS);
  } catch {
    return [];
  }
}

/**
 * Rede de seguranca: se o modelo devolver lixo, escolhe por sobreposicao de
 * palavras. Grosseiro, mas melhor que mandar as 99 e tomar 413.
 */
function byKeyword(userInput, skills) {
  const words = new Set(
    userInput
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2)
  );

  const scored = skills.map((skill) => {
    const terms = [skill.name, ...skill.tools.map((t) => t.name)]
      .join(' ')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2);
    const score = terms.reduce((acc, term) => acc + (words.has(term) ? 1 : 0), 0);
    return { skill, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SKILLS)
    .map((s) => s.skill.name);
}

/**
 * Devolve os nomes das skills relevantes pro comando. Array vazio significa
 * "nao consegui decidir" — quem chama decide o que fazer com isso.
 */
export async function pickSkills(userInput, skills) {
  const valid = new Set(skills.map((s) => s.name));

  try {
    const response = await chat({
      system: SYSTEM.replace('{{SKILLS}}', catalog(skills)),
      messages: [{ role: 'user', content: userInput }],
      tools: [],
    });
    const picked = parseNames(response.text, valid);
    if (picked.length) return picked;
  } catch {
    // Cai no heuristico — um erro aqui nao pode derrubar o comando inteiro.
  }

  return byKeyword(userInput, skills);
}
