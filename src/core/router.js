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
- Fale portugues do Brasil, direto, sem formalidade.

Contexto do vault hoje:
{{TODAY}}`;

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

  // Todas as tools de uma vez so cabe quando o provedor aguenta o payload.
  // Quando nao cabe, uma chamada barata escolhe as skills relevantes antes.
  let active = tools;
  const budget = config.llm.toolBudget;
  if (budget && estimateTokens(tools) > budget) {
    const t = Date.now();
    const picked = await pickSkills(userInput, skills);
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
      system: SYSTEM.replace('{{TODAY}}', todayContext()),
      messages,
      tools: active,
    });
    timings.llm += since(t);

    if (response.stopReason !== 'tool_use') {
      const reply = response.text;
      timings.total = since(started);
      setLastReply(reply);
      writeRuntime({ lastTranscript: userInput, lastReply: reply });
      appendDaily('Comando', `**Voce:** ${userInput}\n\n**JARVIS:** ${reply}`);
      return { reply, steps, timings };
    }

    messages.push({ role: 'assistant', text: response.text, toolUses: response.toolUses });

    const results = [];
    for (const use of response.toolUses) {
      const tool = toolIndex.get(use.name);
      ctx.onStep({ tool: use.name, input: use.input });

      if (!tool) {
        results.push({
          id: use.id,
          name: use.name,
          isError: true,
          content: `Tool desconhecida: ${use.name}`,
        });
        continue;
      }

      const toolStarted = Date.now();
      try {
        const output = await tool.handler(use.input, ctx);
        timings.tools += since(toolStarted);
        const content = typeof output === 'string' ? output : JSON.stringify(output);
        steps.push({ tool: use.name, input: use.input, ok: true });
        recordActivity({ tool: use.name, skill: tool.skillName, ok: true });
        results.push({
          id: use.id,
          name: use.name,
          content: content.slice(0, 8000) || '(sem saida)',
        });
      } catch (err) {
        timings.tools += since(toolStarted);
        steps.push({ tool: use.name, input: use.input, ok: false, error: err.message });
        recordActivity({ tool: use.name, skill: tool.skillName, ok: false, error: err.message });
        results.push({
          id: use.id,
          name: use.name,
          isError: true,
          content: err.message,
        });
      }
    }

    // Atalho: uma tool so, que deu certo, e cuja saida ja e a resposta falada.
    // Sem isso o comando gasta uma viagem inteira ao modelo grande so pra
    // reescrever "Timer de 10 minutos rodando." com outras palavras.
    if (config.fastReply && results.length === 1 && !looksChained(userInput)) {
      const only = results[0];
      const tool = toolIndex.get(only.name);
      if (tool?.speaks && !only.isError) {
        const reply = only.content;
        timings.total = since(started);
        ctx.onNote('resposta direta da tool');
        setLastReply(reply);
        writeRuntime({ lastTranscript: userInput, lastReply: reply });
        appendDaily('Comando', `**Voce:** ${userInput}\n\n**JARVIS:** ${reply}`);
        return { reply, steps, timings };
      }
    }

    messages.push({ role: 'tool', results });
  }

  timings.total = since(started);
  return {
    reply: 'Chegamos no limite de passos sem terminar. Tenta pedir de um jeito mais especifico.',
    steps,
    timings,
  };
}
