import { config } from './config.js';

/**
 * Camada fina entre o router e o provedor de LLM.
 *
 * O router fala um formato so — canonico — e daqui pra baixo cada adapter
 * traduz pro wire format do provedor. Trocar de cerebro nao mexe em skill
 * nenhuma.
 *
 * Formato canonico de mensagem:
 *   { role: 'user',      content: 'texto' }
 *   { role: 'assistant', text: '...', toolUses: [{ id, name, input }] }
 *   { role: 'tool',      results: [{ id, name, content, isError }] }
 *
 * Resposta canonica:
 *   { text, toolUses: [{ id, name, input }], stopReason: 'tool_use' | 'end' }
 */

let client = null;

function parseArgs(raw) {
  // Groq devolve os argumentos como string JSON. Modelo pequeno as vezes manda
  // string vazia quando a tool nao tem parametro.
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** Garante um JSON Schema que os dois provedores aceitam. */
function normalizeSchema(schema) {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} };
  return {
    type: 'object',
    properties: schema.properties || {},
    ...(schema.required?.length ? { required: schema.required } : {}),
  };
}

// ─── Anthropic ──────────────────────────────────────────────────────────────

function anthropicMessages(messages) {
  return messages.map((msg) => {
    if (msg.role === 'user') return { role: 'user', content: msg.content };

    if (msg.role === 'assistant') {
      const blocks = [];
      if (msg.text) blocks.push({ type: 'text', text: msg.text });
      for (const use of msg.toolUses || []) {
        blocks.push({ type: 'tool_use', id: use.id, name: use.name, input: use.input });
      }
      return { role: 'assistant', content: blocks };
    }

    // tool_result volta como turno de user no protocolo da Anthropic
    return {
      role: 'user',
      content: msg.results.map((r) => ({
        type: 'tool_result',
        tool_use_id: r.id,
        content: r.content,
        ...(r.isError ? { is_error: true } : {}),
      })),
    };
  });
}

async function callAnthropic({ system, messages, tools }) {
  if (!client) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    client = new Anthropic({ apiKey: config.llm.apiKey });
  }

  const response = await client.messages.create({
    model: config.llm.model,
    max_tokens: 2048,
    system,
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: normalizeSchema(t.input_schema),
    })),
    messages: anthropicMessages(messages),
  });

  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  const toolUses = response.content
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({ id: b.id, name: b.name, input: b.input || {} }));

  return { text, toolUses, stopReason: toolUses.length ? 'tool_use' : 'end' };
}

// ─── Groq ───────────────────────────────────────────────────────────────────

/** O erro cru da Groq vem como JSON dentro da mensagem. Traduz pro humano. */
function translateGroqError(err) {
  const code = err?.error?.error?.code || err?.code;
  const raw = err?.error?.error?.message || err?.message || '';

  if (code === 'rate_limit_exceeded' || err?.status === 429 || err?.status === 413) {
    if (/tokens per minute|TPM/i.test(raw)) {
      return new Error(
        'Estourou o limite de tokens por minuto do Groq. Espere um minuto e ' +
          'tente de novo, ou baixe JARVIS_TOOL_BUDGET no .env pra mandar menos ' +
          'ferramentas por comando.'
      );
    }
    return new Error('Limite de uso do Groq atingido. Espere um minuto e tente de novo.');
  }

  if (err?.status === 401) {
    return new Error('GROQ_API_KEY invalida ou revogada. Gere outra em console.groq.com/keys.');
  }

  if (code === 'model_not_found' || err?.status === 404) {
    return new Error(
      `Modelo "${config.llm.model}" nao existe no Groq. Veja os disponiveis em ` +
        'console.groq.com/docs/models e ajuste JARVIS_MODEL.'
    );
  }

  return new Error(raw || 'Falha na chamada ao Groq.');
}

function groqMessages(system, messages) {
  const out = [{ role: 'system', content: system }];

  for (const msg of messages) {
    if (msg.role === 'user') {
      out.push({ role: 'user', content: msg.content });
      continue;
    }

    if (msg.role === 'assistant') {
      const entry = { role: 'assistant', content: msg.text || '' };
      if (msg.toolUses?.length) {
        entry.tool_calls = msg.toolUses.map((use) => ({
          id: use.id,
          type: 'function',
          function: { name: use.name, arguments: JSON.stringify(use.input || {}) },
        }));
      }
      out.push(entry);
      continue;
    }

    // Cada resultado vira uma mensagem propria, amarrada pelo tool_call_id
    for (const r of msg.results) {
      out.push({ role: 'tool', tool_call_id: r.id, content: r.content });
    }
  }

  return out;
}

async function callGroq({ system, messages, tools }) {
  if (!client) {
    let Groq;
    try {
      ({ default: Groq } = await import('groq-sdk'));
    } catch {
      throw new Error('Falta o pacote groq-sdk. Rode: npm install groq-sdk');
    }
    // baseURL destravado deixa apontar pra qualquer endpoint compativel com a
    // API da OpenAI (proxy local, outro provedor) sem tocar no codigo.
    client = new Groq({
      apiKey: config.llm.apiKey,
      ...(process.env.GROQ_BASE_URL ? { baseURL: process.env.GROQ_BASE_URL } : {}),
    });
  }

  const request = {
    model: config.llm.model,
    max_tokens: 2048,
    messages: groqMessages(system, messages),
  };

  // Groq rejeita tools: [] — omite o campo quando nao ha ferramenta nenhuma.
  if (tools.length) {
    request.tools = tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: normalizeSchema(t.input_schema),
      },
    }));
    request.tool_choice = 'auto';
  }

  let response;
  try {
    response = await client.chat.completions.create(request);
  } catch (err) {
    throw translateGroqError(err);
  }

  const message = response.choices?.[0]?.message || {};
  const toolUses = (message.tool_calls || []).map((call, i) => ({
    id: call.id || `call_${i}`,
    name: call.function?.name,
    input: parseArgs(call.function?.arguments),
  }));

  return {
    text: (message.content || '').trim(),
    toolUses,
    stopReason: toolUses.length ? 'tool_use' : 'end',
  };
}

// ─── Entrada ────────────────────────────────────────────────────────────────

const PROVIDERS = { anthropic: callAnthropic, groq: callGroq };

export async function chat({ system, messages, tools }) {
  const call = PROVIDERS[config.llm.provider];
  if (!call) {
    throw new Error(
      `Provedor desconhecido: "${config.llm.provider}". Use LLM_PROVIDER=groq ou anthropic.`
    );
  }
  return call({ system, messages, tools });
}
