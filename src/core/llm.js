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
 *   { text, toolUses: [{ id, name, input }], stopReason: 'tool_use' | 'end',
 *     usage: { entrada, saida, cacheEscrito, cacheLido } }
 *
 * `usage` e o unico jeito de saber quanto um comando custou de verdade — os
 * numeros vem do provedor, nao de estimativa. Quem nao informa manda zero.
 */

let client = null;

const SEM_USO = { entrada: 0, saida: 0, cacheEscrito: 0, cacheLido: 0 };

/**
 * O fetch do Node falha com a mensagem inutil "fetch failed" e esconde o
 * motivo em `err.cause` — as vezes com mais de um nivel. Esta funcao cava ate
 * o codigo do sistema e devolve uma frase que diz o que fazer.
 *
 * Sem isso, "sem internet", "porta fechada" e "endereco errado no .env" viram
 * todos a mesma mensagem, e nao da pra saber qual dos tres e.
 */
export function explicarFalhaDeRede(err, alvo) {
  let causa = err;
  const codigos = [];
  let ultimaMensagem = '';
  for (let i = 0; i < 5 && causa; i++) {
    if (causa.code) codigos.push(causa.code);
    // A causa mais funda costuma ser a unica especifica ("bad port", "unable
    // to connect"). Guardada, ela salva o caso sem codigo de sistema.
    if (causa.message && !/^(fetch failed|Connection error\.?)$/i.test(causa.message)) {
      ultimaMensagem = causa.message;
    }
    causa = causa.cause;
  }
  const code = codigos[codigos.length - 1] || codigos[0];
  const onde = alvo ? ` (${alvo})` : '';

  switch (code) {
    case 'ECONNREFUSED':
      return (
        `Ninguem atendeu em ${alvo || 'no endereco configurado'}. ` +
        'Se voce apontou pra um servidor local (Ollama, LM Studio), ele precisa ' +
        'estar rodando ANTES; se nao usa mais, tire OPENAI_BASE_URL do .env.'
      );
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `Nao consegui resolver o endereco${onde}. Ou o .env tem um endereco errado, ou a internet caiu.`;
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
      return `A conexao${onde} estourou o tempo. Rede lenta, firewall ou antivirus segurando o Node.`;
    case 'CERT_HAS_EXPIRED':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
      return `O certificado TLS${onde} nao passou na verificacao — costuma ser antivirus ou proxy inspecionando o trafego.`;
    default:
      return (
        `Nao consegui falar com o provedor${onde}` +
        (code || ultimaMensagem ? ` — ${code || ultimaMensagem}` : '') +
        '. Verifique a internet e, se houver, o endereco no .env.'
      );
  }
}

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

// Cada geracao da Anthropic aceita campos diferentes pra controlar raciocinio,
// e mandar o que o modelo nao conhece volta 400 na hora. Por familia:
//
//   Opus 5, Opus 4.6+,  vem com raciocinio ADAPTATIVO ligado quando o campo
//   Sonnet 5, Sonnet4.6 falta — token de saida cobrado em toda escolha de tool.
//   Fable/Mythos 5      pensam sempre; `thinking: disabled` neles e 400, por
//                       isso ficam de fora da lista de baixo.
//   Haiku 4.5 e antigos ja vem sem raciocinio, e nao conhecem `effort`.
const PENSA_POR_PADRAO = /^claude-(opus-5|opus-4-[678]|sonnet-5|sonnet-4-6)/;
const ACEITA_EFFORT = /^claude-(fable-5|mythos-5|opus-5|opus-4-[5678]|sonnet-5|sonnet-4-6)/;

/**
 * Escolher entre 99 tools e classificacao, nao raciocinio: o modelo le a
 * `description`, acha a que casa e devolve. Deixar o raciocinio adaptativo
 * ligado aqui e pagar token de saida — o mais caro que existe — por uma
 * decisao que ja sai certa sem ele.
 *
 * Entao o padrao e o mais barato que cada modelo permite. `JARVIS_THINKING=1`
 * devolve os padroes do proprio modelo, pra quando valer comparar qualidade.
 */
function anthropicTuning(model) {
  if (['1', 'true', 'yes', 'on'].includes(String(process.env.JARVIS_THINKING).toLowerCase())) {
    return {};
  }

  const extra = {};
  if (PENSA_POR_PADRAO.test(model)) extra.thinking = { type: 'disabled' };
  // Com raciocinio desligado, `effort` ainda governa o quanto o modelo se
  // estende na resposta. "low" e o que queremos numa frase de 1-2 linhas.
  // (No Opus 5, `disabled` so e aceito ate effort "high" — "low" fica dentro.)
  if (ACEITA_EFFORT.test(model)) extra.output_config = { effort: 'low' };
  return extra;
}

async function callAnthropic({ system, context, messages, tools, model, maxTokens }) {
  if (!client) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    client = new Anthropic({ apiKey: config.llm.apiKey });
  }

  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    ...anthropicTuning(model),

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

  const u = response.usage || {};
  return {
    text,
    toolUses,
    stopReason: toolUses.length ? 'tool_use' : 'end',
    usage: {
      entrada: u.input_tokens || 0,
      saida: u.output_tokens || 0,
      cacheEscrito: u.cache_creation_input_tokens || 0,
      cacheLido: u.cache_read_input_tokens || 0,
    },
  };
}

// ─── Compativel com OpenAI (Groq, OpenAI, e qualquer proxy que fale o mesmo) ──
//
// Groq e OpenAI falam o MESMO protocolo em /chat/completions: `messages`,
// `tools`, `tool_calls`. Entao um adapter so atende os dois — o que muda e pra
// onde a requisicao vai e o nome do modelo.
//
// O que NAO da pra reaproveitar e o cliente: o groq-sdk cola "/openai/v1" na
// rota por conta propria, e apontado pra OpenAI ele monta
// api.openai.com/v1/openai/v1/chat/completions. Por isso o caminho da OpenAI
// usa fetch direto — sao vinte linhas e evita mais uma dependencia.
//
// (A Responses API, /v1/responses, e outro protocolo: `input` no lugar de
// `messages`, tools achatadas, saida como lista de itens. Precisaria de um
// adapter proprio e nao traria nada aqui — as tools vao inteiras na requisicao
// dos dois jeitos, e o cache de prefixo da OpenAI e automatico nos dois.)

const OPENAI_BASE = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');

/**
 * Cliente minimo de /chat/completions. Devolve erro no mesmo formato que o
 * groq-sdk levanta (status, headers, error.error.message), pra que o retry de
 * limite e o tradutor de erro sirvam aos dois caminhos sem saber a diferenca.
 */
async function postChatCompletions(request) {
  const url = `${OPENAI_BASE}/chat/completions`;

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.llm.apiKey}`,
      },
      body: JSON.stringify(request),
    });
  } catch (err) {
    const claro = new Error(explicarFalhaDeRede(err, OPENAI_BASE));
    claro.cause = err;
    claro.rede = true;
    throw claro;
  }

  const texto = await res.text();
  let corpo;
  try {
    corpo = JSON.parse(texto);
  } catch {
    corpo = { error: { message: texto.slice(0, 300) } };
  }

  if (!res.ok) {
    const err = new Error(corpo?.error?.message || `HTTP ${res.status}`);
    err.status = res.status;
    err.headers = Object.fromEntries(res.headers);
    // O tradutor procura em error.error — mesma profundidade do groq-sdk.
    err.error = corpo;
    throw err;
  }

  return corpo;
}

// Os modelos de raciocinio da OpenAI recusam `max_tokens` e querem
// `max_completion_tokens`. Nos demais os dois nomes valem.
const QUER_MAX_COMPLETION = /^(gpt-5|o[1-4])/;

/**
 * O limite do Groq e por minuto e se recompoe sozinho. Esperar alguns segundos
 * e tentar de novo resolve o caso comum — dois comandos seguidos — sem exigir
 * nada do usuario. So a segunda falha vira erro.
 */
async function comEsperaNoLimite(chamada) {
  try {
    return await chamada();
  } catch (err) {
    const code = err?.error?.error?.code;
    const limite = err?.status === 429 || code === 'rate_limit_exceeded';
    if (!limite) throw err;

    // 429 tambem e o codigo de "acabou o credito". Esse nao se recompoe com o
    // tempo — esperar so atrasa a mensagem que a pessoa precisa ler.
    if (code === 'insufficient_quota') throw err;

    // O Groq diz quanto esperar, no cabecalho ou na propria mensagem.
    const cabecalho = Number(err?.headers?.['retry-after']);
    const naMensagem = String(err?.error?.error?.message || '').match(/try again in ([\d.]+)s/i);
    const segundos = cabecalho || (naMensagem ? Number(naMensagem[1]) : 12);

    // Acima disso a espera incomoda mais que o erro — melhor devolver a
    // mensagem e deixar a pessoa decidir.
    if (!Number.isFinite(segundos) || segundos > 30) throw err;

    console.error(`[llm] limite por minuto atingido, tentando de novo em ${segundos.toFixed(0)}s...`);
    await new Promise((r) => setTimeout(r, segundos * 1000 + 500));
    return chamada();
  }
}

/** O erro cru vem como JSON dentro da mensagem. Traduz pro humano. */
function translateOpenAIError(err, provider) {
  const code = err?.error?.error?.code || err?.code;
  const raw = err?.error?.error?.message || err?.message || '';
  const nome = provider === 'groq' ? 'Groq' : 'OpenAI';
  const noProvedor = provider === 'groq' ? 'no Groq' : 'na OpenAI';

  if (code === 'rate_limit_exceeded' || err?.status === 429 || err?.status === 413) {
    if (/tokens per minute|TPM/i.test(raw)) {
      return new Error(
        `Estourou o limite de tokens por minuto ${noProvedor}. Espere um minuto e ` +
          'tente de novo, ou baixe JARVIS_TOOL_BUDGET no .env pra mandar menos ' +
          'ferramentas por comando.'
      );
    }
    if (provider === 'openai' && /quota|billing/i.test(raw)) {
      return new Error(
        'A conta da OpenAI esta sem credito. Nao existe free tier ali — precisa ' +
          'por credito em platform.openai.com/billing.'
      );
    }
    return new Error(`Limite de uso do ${nome} atingido. Espere um minuto e tente de novo.`);
  }

  if (err?.status === 401) {
    return new Error(
      provider === 'groq'
        ? 'GROQ_API_KEY invalida ou revogada. Gere outra em console.groq.com/keys.'
        : 'OPENAI_API_KEY invalida ou revogada. Gere outra em platform.openai.com/api-keys.'
    );
  }

  if (code === 'model_not_found' || err?.status === 404) {
    return new Error(
      `Modelo "${config.llm.model}" nao existe ${noProvedor}. Ajuste JARVIS_MODEL — a ` +
        'lista esta em ' +
        (provider === 'groq' ? 'console.groq.com/docs/models.' : 'platform.openai.com/docs/models.')
    );
  }

  if (code === 'tool_use_failed') {
    return new Error(
      'O modelo tentou chamar uma ferramenta e escreveu errado — acontece com ' +
        'modelos abertos. Repita o comando; se insistir, baixe JARVIS_TOOL_BUDGET ' +
        'no .env (menos ferramentas por vez = menos confusao) ou troque pra Anthropic.'
    );
  }

  return new Error(raw || `Falha na chamada ao ${nome}.`);
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

async function callOpenAICompat({ system, context, messages, tools, model, maxTokens }) {
  const provider = config.llm.provider;

  if (provider === 'groq' && !client) {
    let Groq;
    try {
      ({ default: Groq } = await import('groq-sdk'));
    } catch {
      throw new Error('Falta o pacote groq-sdk. Rode: npm install groq-sdk');
    }
    client = new Groq({
      apiKey: config.llm.apiKey,
      ...(process.env.GROQ_BASE_URL ? { baseURL: process.env.GROQ_BASE_URL } : {}),
    });
  }

  const request = {
    model,
    // Nenhum dos dois tem cache de prompt controlavel, entao os dois pedacos
    // vao juntos no system. (A OpenAI cacheia prefixo sozinha, sem pedir.)
    messages: groqMessages(context ? `${system}\n\n${context}` : system, messages),
  };

  if (QUER_MAX_COMPLETION.test(model)) request.max_completion_tokens = maxTokens;
  else request.max_tokens = maxTokens;

  // Groq rejeita tools: [] — omite o campo quando nao ha ferramenta nenhuma.
  // (Na OpenAI o array vazio passa, mas omitir tambem funciona.)
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

  const enviar =
    provider === 'groq'
      ? () => client.chat.completions.create(request)
      : () => postChatCompletions(request);

  let response;
  try {
    response = await comEsperaNoLimite(enviar);
  } catch (err) {
    // Falha de rede ja vem explicada — o tradutor abaixo so entende erro de
    // API, e passar por ele transformaria a explicacao boa em generica.
    if (err.rede) throw err;

    // Quando o Llama escreve uma chamada malformada, o Groq recusa com 400 mas
    // devolve em `failed_generation` o texto exato que ele tentou gerar. Quase
    // sempre e o mesmo `<function=nome>{...}</function>` que ja sabemos ler —
    // entao da pra aproveitar em vez de perder o comando.
    const bruto = err?.error?.error?.failed_generation || err?.failed_generation;
    if (bruto) {
      const { calls, cleaned } = extractInlineCalls(String(bruto));
      // Recuperado de um erro: o provedor nao contou tokens, entao vai zerado.
      if (calls.length) {
        return { text: cleaned, toolUses: calls, stopReason: 'tool_use', usage: SEM_USO };
      }
    }
    throw translateOpenAIError(err, provider);
  }

  const u = response.usage || {};
  const usage = {
    // prompt_tokens ja INCLUI o que veio do cache — o cacheLido e um recorte
    // dele, nao uma parcela a somar.
    entrada: u.prompt_tokens || 0,
    saida: u.completion_tokens || 0,
    cacheEscrito: 0, // nenhum dos dois cobra escrita de cache
    cacheLido: u.prompt_tokens_details?.cached_tokens || 0,
  };

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
      return { text: cleaned, toolUses: calls, stopReason: 'tool_use', usage };
    }
  }

  return {
    usage,
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

const PROVIDERS = {
  anthropic: callAnthropic,
  groq: callOpenAICompat,
  openai: callOpenAICompat,
};

// Pra que a mensagem de falha de rede diga QUAL endereco nao respondeu — e a
// diferenca entre "sem internet" e "o .env aponta pro lugar errado".
export const ENDPOINT = {
  anthropic: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  groq: process.env.GROQ_BASE_URL || 'https://api.groq.com',
  openai: OPENAI_BASE,
};

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
      `Provedor desconhecido: "${config.llm.provider}". Use LLM_PROVIDER=groq, openai ou anthropic.`
    );
  }

  try {
    return await call({
      system,
      context,
      messages,
      tools,
      model: fast ? config.llm.fastModel : config.llm.model,
      maxTokens,
    });
  } catch (err) {
    // Os SDKs tambem usam fetch por baixo e reembalam a falha de conexao como
    // APIConnectionError, com o motivo real enterrado em `cause`. Mesmo
    // tratamento do caminho de fetch direto. (O `name` deles fica "Error" — a
    // classe so aparece no constructor, entao a checagem vai pelos dois.)
    const deRede =
      /^(fetch failed|Connection error\.?)$/i.test(err.message || '') ||
      err.constructor?.name === 'APIConnectionError';
    if (!err.rede && deRede) {
      const claro = new Error(explicarFalhaDeRede(err, ENDPOINT[config.llm.provider]));
      claro.cause = err;
      claro.rede = true;
      throw claro;
    }
    throw err;
  }
}
