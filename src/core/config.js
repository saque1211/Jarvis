import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

// fileURLToPath, nao url.pathname: no Windows o pathname vem "/C:/Users/..."
// e o resolve monta "C:\C:\Users\...".
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function bool(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function list(value) {
  if (!value) return [];
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

// ─── Cerebro ────────────────────────────────────────────────────────────────
// Tres provedores: Groq (free tier, rapido), OpenAI (barato por token, sem
// free tier) e Anthropic (roteia melhor com muitas tools). Quem manda e
// LLM_PROVIDER; sem ele, vale a chave que existir, do gratis pro pago.

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
const GROQ_KEY = process.env.GROQ_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;

// Anthropic e paga, entao o padrao e o modelo mais barato que da conta:
// Haiku 4.5, a $1/$5 por milhao de tokens. Com o cache de prompt segurando as
// 99 tools, um comando sai por menos de meio centavo. Quem quiser roteamento
// melhor troca por claude-sonnet-5 no .env — custa 3x e erra menos de tool.
const DEFAULT_MODEL = {
  groq: 'llama-3.3-70b-versatile',
  openai: 'gpt-4.1-mini',
  anthropic: 'claude-haiku-4-5',
};

// Modelo pequeno pras tarefas que nao precisam de raciocinio — hoje so a
// pre-selecao de skills, que devolve um array de 2 palavras. Rodar isso no
// modelo grande e latencia jogada fora.
const DEFAULT_FAST_MODEL = {
  groq: 'llama-3.1-8b-instant',
  openai: 'gpt-4.1-nano',
  anthropic: 'claude-haiku-4-5',
};

const KEY_OF = { groq: GROQ_KEY, openai: OPENAI_KEY, anthropic: ANTHROPIC_KEY };
const KEY_NAME = {
  groq: 'GROQ_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
};

function pickProvider() {
  const explicit = (process.env.LLM_PROVIDER || '').toLowerCase().trim();
  if (explicit) return explicit;
  // Sem escolha explicita, o gratis vem primeiro.
  if (GROQ_KEY) return 'groq';
  if (OPENAI_KEY && !ANTHROPIC_KEY) return 'openai';
  return 'anthropic';
}

// De que provedor um nome de modelo parece ser, ou null quando nao da pra
// dizer. Serve so pra ignorar um JARVIS_MODEL que sobrou da troca anterior —
// sem isso a chamada quebra com um erro que nao explica nada. Na duvida
// (null) o nome passa: pode ser fine-tune, modelo novo ou proxy local.
function guessProvider(model) {
  if (model.startsWith('claude')) return 'anthropic';
  if (/^(gpt-|o[1-4](-|$)|chatgpt-|ft:)/.test(model)) return 'openai';
  if (/^(llama|mixtral|gemma|qwen|deepseek|moonshot|openai\/)/.test(model)) return 'groq';
  return null;
}

function pickModel(provider) {
  const wanted = process.env.JARVIS_MODEL?.trim();
  if (!wanted) return DEFAULT_MODEL[provider] || DEFAULT_MODEL.anthropic;
  const guess = guessProvider(wanted);
  if (guess && guess !== provider) return DEFAULT_MODEL[provider] || DEFAULT_MODEL.anthropic;
  return wanted;
}

const PROVIDER = pickProvider();

export const config = {
  root: ROOT,

  llm: {
    provider: PROVIDER,
    apiKey: KEY_OF[PROVIDER],
    keyName: KEY_NAME[PROVIDER] || 'ANTHROPIC_API_KEY',
    model: pickModel(PROVIDER),
    fastModel:
      process.env.JARVIS_FAST_MODEL?.trim() ||
      DEFAULT_FAST_MODEL[PROVIDER] ||
      DEFAULT_FAST_MODEL.anthropic,
    // Teto de tokens gasto so com definicao de tool. Acima dele o router
    // pre-seleciona skills em vez de mandar as 99. O free tier do Groq da
    // 12k tokens por minuto e o loop faz varias chamadas dentro do mesmo
    // minuto — por isso o teto e bem abaixo disso. Nos pagos o limite nao
    // aperta, entao o padrao e mandar tudo (0 desliga) e deixar o modelo
    // escolher entre as 99, que e onde ele acerta mais.
    toolBudget: Number(process.env.JARVIS_TOOL_BUDGET ?? (PROVIDER === 'groq' ? 3000 : 0)),
  },

  // Atalho legado — varios lugares so querem o nome do modelo pra logar.
  get model() {
    return this.llm.model;
  },
  maxTurns: Number(process.env.JARVIS_MAX_TURNS || 8),

  // Encerra o comando na saida da tool quando ela ja e a resposta falada,
  // em vez de gastar outra ida ao modelo pra reescrever a mesma frase.
  fastReply: bool(process.env.JARVIS_FAST_REPLY, true),

  // Memoria
  vaultPath: path.resolve(process.env.VAULT_PATH || path.join(ROOT, 'vault')),
  // Quanto do log de hoje entra no system prompt. Vai em toda chamada e o log
  // so cresce, entao teto curto: o modelo busca o resto pela skill memory.
  vaultContextChars: Number(process.env.JARVIS_VAULT_CONTEXT || 1200),

  // Voz
  voice: {
    enabled: bool(process.env.VOICE_ENABLED, true),
    // O que faz o JARVIS comecar a ouvir: "wakeword" (precisa da chave da
    // Picovoice), "hotkey" (tecla global, sem chave) ou "enter" (terminal em
    // foco, sem chave). Sem chave configurada, cai em hotkey sozinho.
    trigger:
      process.env.JARVIS_TRIGGER?.toLowerCase().trim() ||
      (process.env.PICOVOICE_ACCESS_KEY ? 'wakeword' : 'hotkey'),
    hotkey: process.env.JARVIS_HOTKEY || 'ctrl+alt+j',
    picovoiceKey: process.env.PICOVOICE_ACCESS_KEY,
    // "jarvis" e uma keyword embutida no Porcupine, nao precisa treinar nada.
    wakeWord: process.env.JARVIS_WAKE_WORD || 'jarvis',
    // Caminho pra um .ppn customizado, se voce treinar o seu.
    wakeWordPath: process.env.JARVIS_WAKE_WORD_PATH || null,
    sensitivity: Number(process.env.JARVIS_WAKE_SENSITIVITY || 0.6),
    // Silencio (ms) que encerra a captura depois que voce para de falar. E
    // tempo morto puro: abaixo de ~700ms ele comeca a cortar no meio da frase
    // de quem fala pausado.
    silenceMs: Number(process.env.JARVIS_SILENCE_MS || 1000),
    // Piso de gravacao. Antes disso o silencio nao encerra nada — protege a
    // pausa que todo mundo faz depois das duas primeiras palavras.
    minCommandMs: Number(process.env.JARVIS_MIN_COMMAND_MS || 1500),
    // Mostra energia, chiado e limiar frame a frame. Pra quando a deteccao nao
    // acerta o fim e voce precisa ver os numeros em vez de adivinhar.
    vadDebug: bool(process.env.JARVIS_VAD_DEBUG, false),
    maxCommandMs: Number(process.env.JARVIS_MAX_COMMAND_MS || 15000),
    micIndex: Number(process.env.JARVIS_MIC_INDEX ?? -1),
    sttCommand: process.env.STT_COMMAND || null,
    // whisper-server mantem o modelo carregado entre um comando e outro. O
    // whisper-cli recarrega os 466 MB toda vez.
    sttServerUrl: process.env.STT_SERVER_URL || null,
    // Vocabulario que o whisper deve esperar. Ele usa isso pra desempatar
    // palavra parecida — "vsscode" vira "VS Code" em vez de virar outra coisa.
    sttPrompt: process.env.STT_PROMPT || null,
    // Teto pra transcricao. Passou disso, e porque travou — melhor um erro
    // legivel que o daemon parado sem explicacao.
    sttTimeoutMs: Number(process.env.STT_TIMEOUT_MS || 60000),
    ttsCommand: process.env.TTS_COMMAND || null,
    // Pedaco do nome da voz SAPI, tipo "maria" ou "daniel". Veja as instaladas
    // com `npm run voices`. Vazio = primeira pt-BR do sistema.
    voiceName: process.env.JARVIS_VOICE || null,
    // SAPI: velocidade vai de -10 (bem devagar) a 10; volume de 0 a 100.
    rate: Math.max(-10, Math.min(10, Number(process.env.JARVIS_VOICE_RATE ?? 1))),
    volume: Math.max(0, Math.min(100, Number(process.env.JARVIS_VOICE_VOLUME ?? 100))),
    speakReplies: bool(process.env.JARVIS_SPEAK, true),
    // "local" toca na placa de som do PC. "phone" serve a fala por HTTP pro
    // navegador do celular — util quando a caixa de som morreu ou voce quer
    // ouvir de outro comodo. Sem ninguem com a pagina aberta, cai no local.
    speakerMode: (process.env.JARVIS_SPEAKER || 'local').toLowerCase().trim(),
    speakerPort: Number(process.env.JARVIS_SPEAKER_PORT || 8790),
  },

  // Som que toca quando um timer vence. Aceita:
  //   beep                    o de sempre (console beep, seco)
  //   off                     silencioso, so a notificacao do Windows
  //   alarm03, tada, chimes   um .wav de C:/Windows/Media (ouca: npm run sons)
  //   C:/caminho/meu.wav      qualquer arquivo seu
  timerSound: (process.env.JARVIS_TIMER_SOM || 'beep').trim(),

  // Seguranca: o exec e o files sao as skills perigosas.
  safety: {
    // Diretorios onde o JARVIS pode escrever/mexer em arquivos.
    allowedRoots: list(process.env.JARVIS_ALLOWED_ROOTS).map((p) => path.resolve(p)),
    // Comandos que exigem confirmacao explicita antes de rodar.
    confirmDestructive: bool(process.env.JARVIS_CONFIRM_DESTRUCTIVE, true),
    commandTimeoutMs: Number(process.env.JARVIS_COMMAND_TIMEOUT_MS || 120000),
  },

  // Integracoes externas
  spotify: {
    clientId: process.env.SPOTIFY_CLIENT_ID,
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
    tokenFile: path.join(ROOT, '.secrets', 'spotify.json'),
  },
  github: {
    token: process.env.GITHUB_TOKEN,
    defaultRepo: process.env.GITHUB_DEFAULT_REPO,
  },
  discord: {
    webhookUrl: process.env.DISCORD_WEBHOOK_URL,
  },
  homeAssistant: {
    baseUrl: process.env.HOME_ASSISTANT_URL,
    token: process.env.HOME_ASSISTANT_TOKEN,
  },
  brave: {
    apiKey: process.env.BRAVE_API_KEY,
  },
  edgeTts: {
    // Vozes pt-BR: AntonioNeural, FranciscaNeural, ThalitaNeural, DonatoNeural,
    // BrendaNeural, HumbertoNeural. Vazio desliga.
    voice: process.env.EDGE_TTS_VOICE || null,
    rate: process.env.EDGE_TTS_RATE || '+0%',
    volume: process.env.EDGE_TTS_VOLUME || '+0%',
  },
  fishAudio: {
    apiKey: process.env.FISH_AUDIO_API_KEY,
    // O reference_id da voz, o que aparece na pagina dela.
    voiceId: process.env.FISH_AUDIO_VOICE_ID,
    model: process.env.FISH_AUDIO_MODEL || 's1',
  },
  freelance: {
    // Workana e Fiverr nao tem API publica de freelancer. O watcher trabalha
    // com feeds RSS/URLs autenticadas que voce fornecer. Veja .skills/freelance.md
    feeds: list(process.env.FREELANCE_FEEDS),
    workanaCookie: process.env.WORKANA_COOKIE,
  },

  paths: {
    apps: path.join(ROOT, 'config', 'apps.json'),
    projects: path.join(ROOT, 'config', 'projects.json'),
    secrets: path.join(ROOT, '.secrets'),
    captures: path.resolve(process.env.JARVIS_CAPTURE_DIR || path.join(os.homedir(), 'Pictures', 'Jarvis')),
  },
};

export function ensureDirs() {
  const dirs = [
    config.vaultPath,
    path.join(config.vaultPath, 'daily'),
    path.join(config.vaultPath, 'tasks'),
    path.join(config.vaultPath, 'notes'),
    path.join(config.vaultPath, 'logs'),
    config.paths.secrets,
  ];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

export function loadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function saveJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}
