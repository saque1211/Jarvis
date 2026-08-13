import { config } from './config.js';
import { chat } from './llm.js';
import { loadSkills, buildToolIndex, toolSpecs } from './registry.js';
import { pickSkills, estimateTokens } from './preselect.js';
import { todayContext, appendDaily } from './vault.js';
import { setLastReply } from '../skills/voice.js';
import { recordActivity, writeRuntime } from './state.js';

const SYSTEM = `Voce e o JARVIS, assistente pessoal do usuario, rodando na maquina dele (Windows 11).

Mentalidade: SPEAK. ROUTE. REMEMBER. REPEAT.

Regras:
- Voce controla a maquina de verdade atraves das tools. Use-as em vez de explicar como fazer.
- Suas respostas sao LIDAS EM VOZ ALTA. Seja curto: 1 ou 2 frases. Sem markdown, sem listas, sem emoji.
- Se o comando veio por voz, a transcricao pode ter erros. Interprete a intencao provavel.
  "abre o discórdia" = abrir Discord. "toca aquela musica" = retomar o Spotify.
- Encadeie tools quando fizer sentido: abrir o VS Code num projeto = resolver o projeto, depois abrir.
- Antes de qualquer coisa destrutiva (deletar, sobrescrever, matar processo, force push),
  pergunte primeiro em uma frase curta. Nao execute e avise depois.
- Se faltar credencial pra uma integracao, diga em uma frase qual variavel de ambiente falta.
- Fale portugues do Brasil, direto, sem formalidade.`;

// Pistas de que o comando tem mais de uma intencao. Na duvida o router faz a
// viagem extra ao modelo — errar aqui pro lado do "otimiza" perderia acao.
const CHAINED = /(^|\s)(e|depois|dai|entao|tambem|ai|ainda)(\s|$)|[,;]/;

function looksChained(input) {
  return CHAINED.test(input.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
}

let cached = null;

async function getRuntime() {
  if (cached) return cached;
  const skills = await loadSkills();
  cached = {
    skills,
    toolIndex: buildToolIndex(skills),
    tools: toolSpecs(skills),
  };
  return cached;
}

/**
 * Roda o loop de tool-use ate o modelo parar de pedir ferramentas.
 * Devolve { reply, steps } — steps e a trilha do que foi executado de fato.
 */
export async function route(userInput, options = {}) {
  if (!config.llm.apiKey) {
    throw new Error(
      `Falta ${config.llm.keyName} no .env — o JARVIS nao tem cerebro sem isso.`
    );
  }

  const { skills, toolIndex, tools } = await getRuntime();

  const ctx = {
    skills,
    source: options.source || 'cli',
    onStep: options.onStep || (() => {}),
    onNote: options.onNote || (() => {}),
    confirm: options.confirm || (async () => false),
  };

  const started = Date.now();
  const timings = { preselect: 0, llm: 0, tools: 0, total: 0 };
  const since = (t) => Date.now() - t;

  // Soma de todas as idas ao modelo dentro de UM comando — e isso que aparece
  // na fatura, nao o custo de uma chamada isolada.
  const usage = { entrada: 0, saida: 0, cacheEscrito: 0, cacheLido: 0, chamadas: 0 };
  const somar = (u) => {
    if (!u) return;
    usage.chamadas++;
    for (const k of ['entrada', 'saida', 'cacheEscrito', 'cacheLido']) usage[k] += u[k] || 0;
  };

  // Todas as tools de uma vez so cabe quando o provedor aguenta o payload.
  // Quando nao cabe, uma chamada barata escolhe as skills relevantes antes.
  let active = tools;
  const budget = config.llm.toolBudget;
  if (budget && estimateTokens(tools) > budget) {
    const t = Date.now();
    const picked = await pickSkills(userInput, skills, somar);
    timings.preselect = since(t);
    if (picked.length) {
      active = toolSpecs(skills.filter((s) => picked.includes(s.name)));
      ctx.onNote(`skills: ${picked.join(', ')} (${timings.preselect}ms)`);
    }
  }

  const messages = [{ role: 'user', content: userInput }];
  const steps = [];

  for (let turn = 0; turn < config.maxTurns; turn++) {
    const t = Date.now();
    const response = await chat({
      // Estatico e volatil separados: o system nunca muda, entao ele e as tools
      // podem ficar em cache. O vault muda a cada comando e vai depois.
      system: SYSTEM,
      context: `Contexto do vault hoje:\n${todayContext()}`,
      messages,
      tools: active,
    });
    timings.llm += since(t);
    somar(response.usage);

    if (response.stopReason !== 'tool_use') {
      const reply = response.text;
      timings.total = since(started);
      setLastReply(reply);
      writeRuntime({ lastTranscript: userInput, lastReply: reply });
      appendDaily('Comando', `**Voce:** ${userInput}\n\n**JARVIS:** ${reply}`);
      return { reply, steps, timings, usage };
    }

    messages.push({ role: 'assistant', text: response.text, toolUses: response.toolUses });

    // Em paralelo: quando o modelo pede duas tools na mesma rodada, ele ja
    // decidiu que sao independentes. Uma de cada vez faria o comando custar a
    // soma, e nao a mais lenta.
    const batchStarted = Date.now();
    const results = await Promise.all(
      response.toolUses.map(async (use) => {
        const tool = toolIndex.get(use.name);
        ctx.onStep({ tool: use.name, input: use.input });

        if (!tool) {
          return {
            id: use.id,
            name: use.name,
            isError: true,
            content: `Tool desconhecida: ${use.name}`,
            step: { tool: use.name, input: use.input, ok: false, error: 'tool desconhecida' },
          };
        }

        try {
          const output = await tool.handler(use.input, ctx);
          const content = typeof output === 'string' ? output : JSON.stringify(output);
          return {
            id: use.id,
            name: use.name,
            content: content.slice(0, 8000) || '(sem saida)',
            step: { tool: use.name, input: use.input, ok: true },
            skillName: tool.skillName,
          };
        } catch (err) {
          return {
            id: use.id,
            name: use.name,
            isError: true,
            content: err.message,
            step: { tool: use.name, input: use.input, ok: false, error: err.message },
            skillName: tool.skillName,
          };
        }
      })
    );
    // Relogio de parede do lote, nao a soma — senao o paralelo "pioraria" o numero.
    timings.tools += since(batchStarted);

    // A trilha sai na ordem em que o modelo pediu, nao na ordem em que terminou.
    for (const r of results) {
      steps.push(r.step);
      if (r.skillName) {
        recordActivity({ tool: r.name, skill: r.skillName, ok: r.step.ok, error: r.step.error });
      }
      delete r.step;
      delete r.skillName;
    }

    // Atalho: uma tool so, que deu certo, e cuja saida ja e a resposta falada.
    // Sem isso o comando gasta uma viagem inteira ao modelo grande so pra
    // reescrever "Timer de 10 minutos rodando." com outras palavras.
    if (config.fastReply && results.length === 1 && !looksChained(userInput)) {
      const only = results[0];
      const tool = toolIndex.get(only.name);
      // `speaks` pode ser funcao: a tool decide pela entrada se a saida dela ja
      // e a resposta (system_stats com foco e, sem foco nao e).
      const speaks =
        typeof tool?.speaks === 'function' ? tool.speaks(response.toolUses[0].input) : tool?.speaks;
      if (speaks && !only.isError) {
        const reply = only.content;
        timings.total = since(started);
        ctx.onNote('resposta direta da tool');
        setLastReply(reply);
        writeRuntime({ lastTranscript: userInput, lastReply: reply });
        appendDaily('Comando', `**Voce:** ${userInput}\n\n**JARVIS:** ${reply}`);
        return { reply, steps, timings, usage };
      }
    }

    messages.push({ role: 'tool', results });
  }

  timings.total = since(started);
  return {
    reply: 'Chegamos no limite de passos sem terminar. Tenta pedir de um jeito mais especifico.',
    steps,
    timings,
    usage,
  };
}
