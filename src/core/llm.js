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

async function callAnthropic({ system, context, messages, tools, model, maxTokens }) {
  if (!client) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    client = new Anthropic({ apiKey: config.llm.apiKey });
  }

  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,

    // Cache de prompt. A ordem que a Anthropic monta e tools -> system ->
    // messages, entao um marcador no fim da parte estatica do system guarda as
    // 99 tools junto — sao ~14 mil tokens que iriam inteiros em toda chamada.
    // O contexto do vault vem DEPOIS do marcador de proposito: ele muda a cada
    // comando, e qualquer byte diferente antes do marcador invalidaria tudo.
    system: [
      { type: 'text', text: system, cache_control: { type: 'ephemeral' } },
      ...(context ? [{ type: 'text', text: context }] : []),
    ],

    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: normalizeSchema(t.input_schema),
    })),
    messages: anthropicMessages(messages),
  });

  // Leitura de cache custa ~10% do preco de entrada. Zero aqui, em chamadas
  // seguidas, significa que alguma coisa esta invalidando o prefixo.
  if (process.env.JARVIS_LLM_DEBUG) {
    const u = response.usage;
    console.error(
      `[llm] entrada ${u.input_tokens} · cache escrito ${u.cache_creation_input_tokens ?? 0}` +
        ` · cache lido ${u.cache_read_input_tokens ?? 0}`
    );
  }

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

/**
 * O limite do Groq e por minuto e se recompoe sozinho. Esperar alguns segundos
 * e tentar de novo resolve o caso comum — dois comandos seguidos — sem exigir
 * nada do usuario. So a segunda falha vira erro.
 */
async function comEsperaNoLimite(chamada) {
  try {
    return await chamada();
  } catch (err) {
    const limite =
      err?.status === 429 || err?.error?.error?.code === 'rate_limit_exceeded';
    if (!limite) throw err;

    // O Groq diz quanto esperar, no cabecalho ou na propria mensagem.
    const cabecalho = Number(err?.headers?.['retry-after']);
    const naMensagem = String(err?.error?.error?.message || '').match(/try again in ([\d.]+)s/i);
    const segundos = cabecalho || (naMensagem ? Number(naMensagem[1]) : 12);

    // Acima disso a espera incomoda mais que o erro — melhor devolver a
    // mensagem e deixar a pessoa decidir.
    if (!Number.isFinite(segundos) || segundos > 30) throw err;

    console.error(`[llm] limite do Groq atingido, tentando de novo em ${segundos.toFixed(0)}s...`);
    await new Promise((r) => setTimeout(r, segundos * 1000 + 500));
    return chamada();
  }
}

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

  if (code === 'tool_use_failed') {
    return new Error(
      'O modelo tentou chamar uma ferramenta e escreveu errado — acontece com ' +
        'modelos abertos. Repita o comando; se insistir, baixe JARVIS_TOOL_BUDGET ' +
        'no .env (menos ferramentas por vez = menos confusao) ou troque pra Anthropic.'
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

async function callGroq({ system, context, messages, tools, model, maxTokens }) {
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
    model,
    max_tokens: maxTokens,
    // O Groq nao tem cache de prompt, entao os dois pedacos vao juntos.
    messages: groqMessages(context ? `${system}\n\n${context}` : system, messages),
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
    response = await comEsperaNoLimite(() => client.chat.completions.create(request));
  } catch (err) {
    // Quando o Llama escreve uma chamada malformada, o Groq recusa com 400 mas
    // devolve em `failed_generation` o texto exato que ele tentou gerar. Quase
    // sempre e o mesmo `<function=nome>{...}</function>` que ja sabemos ler —
    // entao da pra aproveitar em vez de perder o comando.
    const bruto = err?.error?.error?.failed_generation || err?.failed_generation;
    if (bruto) {
      const { calls, cleaned } = extractInlineCalls(String(bruto));
      if (calls.length) return { text: cleaned, toolUses: calls, stopReason: 'tool_use' };
    }
    throw translateGroqError(err);
  }

  const message = response.choices?.[0]?.message || {};
  const toolUses = (message.tool_calls || []).map((call, i) => ({
    id: call.id || `call_${i}`,
    name: call.function?.name,
    input: parseArgs(call.function?.arguments),
  }));

  let text = (message.content || '').trim();

  // O Llama as vezes escreve a chamada no meio do texto em vez de usar o campo
  // tool_calls. Sem tratar, o router entende como resposta final e o TTS le a
  // marcacao em voz alta.
  if (!toolUses.length && text) {
    const { calls, cleaned } = extractInlineCalls(text);
    if (calls.length) {
      return { text: cleaned, toolUses: calls, stopReason: 'tool_use' };
    }
  }

  return {
    text,
    toolUses,
    stopReason: toolUses.length ? 'tool_use' : 'end',
  };
}

/**
 * Garimpa chamadas de tool escritas como texto. Os formatos que o Llama produz
 * quando escorrega do protocolo:
 *
 *   <function=nome>{"a": 1}</function>
 *   <function_call>{"name": "nome", "arguments": {...}}</function_call>
 *   <tool_call>{"name": "nome", "parameters": {...}}</tool_call>
 */
function extractInlineCalls(text) {
  const calls = [];
  let cleaned = text;
  let index = 0;

  // <function=nome>{...}</function>
  cleaned = cleaned.replace(
    /<function=([\w.-]+)>\s*([\s\S]*?)\s*<\/function>/g,
    (_, name, args) => {
      calls.push({ id: `inline_${index++}`, name, input: parseArgs(args) });
      return '';
    }
  );

  // <function_call>/<tool_call> com o nome dentro do JSON
  cleaned = cleaned.replace(
    /<(?:function_call|tool_call)>\s*([\s\S]*?)\s*<\/(?:function_call|tool_call)>/g,
    (whole, body) => {
      const parsed = parseArgs(body);
      if (!parsed?.name) return whole;
      calls.push({
        id: `inline_${index++}`,
        name: parsed.name,
        input: parsed.arguments || parsed.parameters || {},
      });
      return '';
    }
  );

  return { calls, cleaned: cleaned.replace(/\s+/g, ' ').trim() };
}

// ─── Entrada ────────────────────────────────────────────────────────────────

const PROVIDERS = { anthropic: callAnthropic, groq: callGroq };

/**
 * `fast: true` troca pro modelo pequeno. Use nas etapas que sao classificacao,
 * nao raciocinio — o modelo grande ali e so latencia.
 */
export async function chat({
  system,
  // Parte que muda a cada comando. Fica separada pra nao invalidar o cache do
  // que e estavel — veja o adapter da Anthropic.
  context = null,
  messages,
  tools = [],
  fast = false,
  maxTokens = 2048,
}) {
  const call = PROVIDERS[config.llm.provider];
  if (!call) {
    throw new Error(
      `Provedor desconhecido: "${config.llm.provider}". Use LLM_PROVIDER=groq ou anthropic.`
    );
  }
  return call({
    system,
    context,
    messages,
    tools,
    model: fast ? config.llm.fastModel : config.llm.model,
    maxTokens,
  });
}
