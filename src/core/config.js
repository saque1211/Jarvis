import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import 'dotenv/config';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

function bool(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function list(value) {
  if (!value) return [];
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

export const config = {
  root: ROOT,

  // Cerebro
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY,
  // Sonnet roteia rapido o suficiente pra voz. Troque por claude-opus-5 se
  // quiser raciocinio mais pesado em troca de latencia.
  model: process.env.JARVIS_MODEL || 'claude-sonnet-5',
  maxTurns: Number(process.env.JARVIS_MAX_TURNS || 8),

  // Memoria
  vaultPath: path.resolve(process.env.VAULT_PATH || path.join(ROOT, 'vault')),

  // Voz
  voice: {
    enabled: bool(process.env.VOICE_ENABLED, true),
    picovoiceKey: process.env.PICOVOICE_ACCESS_KEY,
    // "jarvis" e uma keyword embutida no Porcupine, nao precisa treinar nada.
    wakeWord: process.env.JARVIS_WAKE_WORD || 'jarvis',
    // Caminho pra um .ppn customizado, se voce treinar o seu.
    wakeWordPath: process.env.JARVIS_WAKE_WORD_PATH || null,
    sensitivity: Number(process.env.JARVIS_WAKE_SENSITIVITY || 0.6),
    // Silencio (ms) que encerra a captura do comando depois do wake word.
    silenceMs: Number(process.env.JARVIS_SILENCE_MS || 1200),
    maxCommandMs: Number(process.env.JARVIS_MAX_COMMAND_MS || 15000),
    micIndex: Number(process.env.JARVIS_MIC_INDEX ?? -1),
    sttCommand: process.env.STT_COMMAND || null,
    ttsCommand: process.env.TTS_COMMAND || null,
    speakReplies: bool(process.env.JARVIS_SPEAK, true),
  },

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
