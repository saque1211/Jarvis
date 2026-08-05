import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { loadSkills, buildToolIndex, toAnthropicTools } from './registry.js';
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

let cached = null;

async function getRuntime() {
  if (cached) return cached;
  const skills = await loadSkills();
  cached = {
    skills,
    toolIndex: buildToolIndex(skills),
    anthropicTools: toAnthropicTools(skills),
  };
  return cached;
}

function textOf(message) {
  return message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/**
 * Roda o loop de tool-use ate o Claude parar de pedir ferramentas.
 * Devolve { reply, steps } — steps e a trilha do que foi executado de fato.
 */
export async function route(userInput, options = {}) {
  if (!config.anthropicApiKey) {
    throw new Error('Falta ANTHROPIC_API_KEY no .env — o JARVIS nao tem cerebro sem isso.');
  }

  const { skills, toolIndex, anthropicTools } = await getRuntime();
  const client = new Anthropic({ apiKey: config.anthropicApiKey });

  const ctx = {
    skills,
    source: options.source || 'cli',
    onStep: options.onStep || (() => {}),
    confirm: options.confirm || (async () => false),
  };

  const messages = [{ role: 'user', content: userInput }];
  const steps = [];

  for (let turn = 0; turn < config.maxTurns; turn++) {
    const response = await client.messages.create({
      model: config.model,
      max_tokens: 2048,
      system: SYSTEM.replace('{{TODAY}}', todayContext()),
      tools: anthropicTools,
      messages,
    });

    if (response.stop_reason !== 'tool_use') {
      const reply = textOf(response);
      setLastReply(reply);
      writeRuntime({ lastTranscript: userInput, lastReply: reply });
      appendDaily('Comando', `**Voce:** ${userInput}\n\n**JARVIS:** ${reply}`);
      return { reply, steps };
    }

    messages.push({ role: 'assistant', content: response.content });

    const results = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;

      const tool = toolIndex.get(block.name);
      ctx.onStep({ tool: block.name, input: block.input });

      if (!tool) {
        results.push({
          type: 'tool_result',
          tool_use_id: block.id,
          is_error: true,
          content: `Tool desconhecida: ${block.name}`,
        });
        continue;
      }

      try {
        const output = await tool.handler(block.input, ctx);
        const content = typeof output === 'string' ? output : JSON.stringify(output);
        steps.push({ tool: block.name, input: block.input, ok: true });
        recordActivity({ tool: block.name, skill: tool.skillName, ok: true });
        results.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: content.slice(0, 8000) || '(sem saida)',
        });
      } catch (err) {
        steps.push({ tool: block.name, input: block.input, ok: false, error: err.message });
        recordActivity({ tool: block.name, skill: tool.skillName, ok: false, error: err.message });
        results.push({
          type: 'tool_result',
          tool_use_id: block.id,
          is_error: true,
          content: err.message,
        });
      }
    }

    messages.push({ role: 'user', content: results });
  }

  return {
    reply: 'Chegamos no limite de passos sem terminar. Tenta pedir de um jeito mais especifico.',
    steps,
  };
}
