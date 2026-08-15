import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { config, ensureDirs } from './config.js';
import { listVaultFiles, readVaultFile, today } from './vault.js';
import { timerSnapshot } from '../skills/timer.js';

/**
 * Snapshot de estado do JARVIS — a fonte unica de verdade do HUD.
 *
 * Este modulo define o CONTRATO: o que o HUD desenha e exatamente o que sai
 * daqui. Design e implementacao concordam porque leem o mesmo formato.
 *
 * Regra: nada aqui pode demorar. Leituras de disco sao pequenas e as chamadas
 * caras (CPU, GPU, Spotify) sao opcionais e entram por parametro — o HUD as
 * pede em cadencia propria, mais lenta que o resto.
 */

function runtimeFile() {
  ensureDirs();
  return path.join(config.vaultPath, 'logs', 'runtime.json');
}

/** O daemon escreve aqui a cada evento; o HUD le. */
export function writeRuntime(patch) {
  const file = runtimeFile();
  let current = {};
  try {
    if (fs.existsSync(file)) current = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    current = {};
  }
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

export function readRuntime() {
  const file = runtimeFile();
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // Runtime corrompido nao pode derrubar o HUD.
  }
  return {};
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function tasksPanel() {
  const file = path.join(config.vaultPath, 'tasks', 'tasks.json');
  const all = readJson(file, []);
  const hoje = today();
  const pending = all.filter((t) => !t.done);

  const weight = { alta: 0, media: 1, baixa: 2 };
  const sorted = [...pending].sort((a, b) => {
    const aLate = a.due && a.due < hoje ? 0 : 1;
    const bLate = b.due && b.due < hoje ? 0 : 1;
    if (aLate !== bLate) return aLate - bLate;
    return (weight[a.priority] ?? 1) - (weight[b.priority] ?? 1);
  });

  return {
    total: pending.length,
    overdue: pending.filter((t) => t.due && t.due < hoje).length,
    dueToday: pending.filter((t) => t.due === hoje).length,
    completedToday: all.filter((t) => t.done && t.completedAt?.startsWith(hoje)).length,
    items: sorted.slice(0, 6).map((t) => ({
      id: t.id,
      title: t.title,
      priority: t.priority,
      due: t.due,
      overdue: Boolean(t.due && t.due < hoje),
      project: t.project,
    })),
  };
}

function remindersPanel() {
  const file = path.join(config.vaultPath, 'tasks', 'reminders.json');
  const all = readJson(file, []);
  const now = Date.now();

  return all
    .filter((r) => !r.fired && new Date(r.when).getTime() > now)
    .sort((a, b) => new Date(a.when) - new Date(b.when))
    .slice(0, 5)
    .map((r) => ({
      id: r.id,
      message: r.message,
      at: r.when,
      inMs: new Date(r.when).getTime() - now,
      alarm: Boolean(r.alarm),
    }));
}

function vaultPanel() {
  return listVaultFiles()
    .slice(0, 5)
    .map((f) => {
      const content = readVaultFile(f.path) || '';
      // Ultima secao do arquivo — e o que aconteceu mais recentemente.
      const lastSection = content.split(/\n## /).pop() || '';
      return {
        path: f.path,
        at: new Date(f.mtime).toISOString(),
        excerpt: lastSection.replace(/[#*_`]/g, '').trim().slice(0, 140),
      };
    });
}

function systemPanel() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  return {
    clock: new Date().toISOString(),
    hostname: os.hostname(),
    uptimeMs: os.uptime() * 1000,
    // Leitura barata de RAM. Os vitais completos (GPU, disco) vem da skill
    // hardware, que custa um PowerShell e roda em cadencia mais lenta.
    memory: {
      totalGb: +(totalMem / 1e9).toFixed(1),
      usedGb: +((totalMem - freeMem) / 1e9).toFixed(1),
      percent: Math.round(((totalMem - freeMem) / totalMem) * 100),
    },
    loadAverage: os.loadavg()[0],
  };
}

/**
 * Monta o snapshot completo. Tudo aqui e leitura de disco e memoria — roda em
 * milissegundos, pode ser chamado 1x por segundo sem dó.
 */
export function snapshot() {
  const runtime = readRuntime();
  const timers = timerSnapshot();

  return {
    version: 1,
    generatedAt: new Date().toISOString(),

    // Painel VOICE — estado do daemon de escuta.
    voice: {
      // idle | listening | thinking | speaking | offline
      state: runtime.voiceState || 'offline',
      wakeWord: config.voice.wakeWord,
      lastTranscript: runtime.lastTranscript || null,
      lastReply: runtime.lastReply || null,
      lastAt: runtime.updatedAt || null,
      sttEngine: runtime.sttEngine || null,
      micDevice: runtime.micDevice || null,
    },

    // Painel VITALS — parte barata; a cara vem da skill hardware.
    system: systemPanel(),

    // Painel TIMERS — contagem regressiva e cronometros.
    timers: timers.timers,
    stopwatches: timers.stopwatches,

    // Painel TASKS — o que precisa acontecer hoje.
    tasks: tasksPanel(),

    // Painel SCHEDULE — o que vai disparar sozinho.
    reminders: remindersPanel(),

    // Painel ACTIVITY — as ultimas tools executadas.
    activity: (runtime.activity || []).slice(-12).reverse(),

    // Painel COMMANDS — o que foi PEDIDO, na frase da pessoa.
    commands: (runtime.commands || []).slice(-8).reverse(),

    // Painel USO — quanto o dia custou ate agora.
    uso: runtime.uso?.dia === today() ? runtime.uso : { dia: today(), entrada: 0, saida: 0, comandos: 0 },

    // Painel VAULT — memoria recente.
    vault: vaultPanel(),

    // Painel NOW PLAYING — preenchido pelo HUD via skill media, cadencia lenta.
    nowPlaying: runtime.nowPlaying || null,
  };
}

/**
 * Guarda o comando como a pessoa disse, nao a tool que ele virou.
 *
 * `activity` ja registra as tools, mas "start_timer" nao e o que ela lembra
 * ter pedido — ela lembra "poe 10 minutos". O painel mostra a frase.
 */
export function recordCommand(text, reply, usage = null) {
  if (!text?.trim()) return;
  const runtime = readRuntime();
  const commands = [
    ...(runtime.commands || []),
    { text: text.trim(), reply: reply?.trim() || null, at: new Date().toISOString() },
  ];

  // Consumo acumulado do dia. O contador zera sozinho na virada da data: sem
  // isso o numero cresceria pra sempre e deixaria de dizer alguma coisa.
  const hoje = today();
  const anterior = runtime.uso?.dia === hoje ? runtime.uso : { dia: hoje, entrada: 0, saida: 0, comandos: 0 };
  const uso = usage
    ? {
        dia: hoje,
        entrada: anterior.entrada + (usage.entrada || 0) + (usage.cacheLido || 0) + (usage.cacheEscrito || 0),
        saida: anterior.saida + (usage.saida || 0),
        comandos: anterior.comandos + 1,
      }
    : { ...anterior, comandos: anterior.comandos + 1 };

  writeRuntime({ commands: commands.slice(-20), uso });
}

/** Registra uma tool executada no histórico do runtime (buffer de 30). */
export function recordActivity(entry) {
  const runtime = readRuntime();
  const activity = [...(runtime.activity || []), { ...entry, at: new Date().toISOString() }];
  writeRuntime({ activity: activity.slice(-30) });
}
