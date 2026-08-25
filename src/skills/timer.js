import fs from 'node:fs';
import path from 'node:path';
import { toast, ps, psQuote } from '../platform/win32.js';
import { config, ensureDirs } from '../core/config.js';
import { appendDaily } from '../core/vault.js';

// Onde procurar um som pelo nome curto, nesta ordem. Os do projeto vem antes:
// se alguem pos um alarme em assets/sons, e porque quer aquele.
const PASTAS_DE_SOM = [path.join(config.root, 'assets', 'sons'), 'C:/Windows/Media'];

/**
 * Toca o alarme do timer conforme JARVIS_TIMER_SOM.
 *
 * O beep de console e onda quadrada pura: corta bem, mas e agressivo pra um
 * timer que dispara varias vezes ao dia. Por isso da pra trocar por um .wav —
 * de preferencia um dos que ja existem em C:/Windows/Media.
 */
export async function tocarAlarme(escolha = config.voice.timerSound) {
  const som = String(escolha || 'beep').trim();
  if (som.toLowerCase() === 'off') return;

  if (som.toLowerCase() === 'beep') {
    await ps('for ($i=0; $i -lt 3; $i++) { [console]::beep(880, 250); Start-Sleep -Milliseconds 120 }');
    return;
  }

  const arquivo = resolverSom(som);
  if (!arquivo) return beepar();

  // SoundPlayer so toca WAV. Pra qualquer outro formato entra o MediaPlayer,
  // que abre de forma assincrona — sem esperar a duracao aparecer, o Play()
  // retorna antes do som comecar e nao sai nada.
  const script = /\.wav$/i.test(arquivo)
    ? `(New-Object System.Media.SoundPlayer ${psQuote(arquivo)}).PlaySync()`
    : `Add-Type -AssemblyName PresentationCore
$p = New-Object System.Windows.Media.MediaPlayer
$p.Open([System.Uri]::new(${psQuote(arquivo)}))
$limite = (Get-Date).AddSeconds(5)
while (-not $p.NaturalDuration.HasTimeSpan -and (Get-Date) -lt $limite) { Start-Sleep -Milliseconds 50 }
$p.Play()
if ($p.NaturalDuration.HasTimeSpan) { Start-Sleep -Milliseconds ($p.NaturalDuration.TimeSpan.TotalMilliseconds + 200) }
$p.Close()`;

  const r = await ps(script);
  // Falha ao tocar nao pode significar timer silencioso: o beep assume.
  if (!r.ok) await beepar();
}

function beepar() {
  return ps('for ($i=0; $i -lt 3; $i++) { [console]::beep(880, 250); Start-Sleep -Milliseconds 120 }');
}

/**
 * Nome curto ("alarme", "tada") vira caminho; caminho completo passa direto.
 * Devolve null quando o arquivo nao existe — assim quem chama cai no beep em
 * vez de mandar um caminho inexistente pro PowerShell e receber erro cru.
 */
export function resolverSom(som) {
  if (/[\\/]/.test(som)) return fs.existsSync(som) ? som : null;

  for (const pasta of PASTAS_DE_SOM) {
    for (const ext of ['.wav', '.mp3']) {
      const caminho = path.join(pasta, som + ext);
      if (fs.existsSync(caminho)) return caminho;
    }
  }
  return null;
}

/**
 * Skill: timers, cronometros e pomodoro.
 *
 * O estado vive em disco (vault/tasks/timers.json) por dois motivos: sobrevive
 * a reinicio do JARVIS, e o HUD le o mesmo arquivo — os dois enxergam a mesma
 * verdade sem precisar de servidor no meio.
 *
 * Quem dispara e o daemon de voz, chamando checkDueTimers() a cada segundo.
 */

function stateFile() {
  ensureDirs();
  return path.join(config.vaultPath, 'tasks', 'timers.json');
}

function load() {
  const file = stateFile();
  if (!fs.existsSync(file)) return { timers: [], stopwatches: [] };
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { timers: data.timers || [], stopwatches: data.stopwatches || [] };
  } catch {
    return { timers: [], stopwatches: [] };
  }
}

function save(state) {
  fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2), 'utf8');
}

function nextId(items) {
  return items.reduce((max, i) => Math.max(max, i.id || 0), 0) + 1;
}

/**
 * Converte duracao falada em milissegundos.
 * Cobre "5 minutos", "1 hora e meia", "meia hora", "90 segundos", "25".
 */
export function parseDuration(input) {
  if (typeof input === 'number') return input * 60000; // numero solto = minutos
  const text = String(input).toLowerCase().trim();

  if (/^meia\s+hora$/.test(text)) return 30 * 60000;
  if (/^uma\s+hora\s+e\s+meia$/.test(text)) return 90 * 60000;

  let total = 0;
  let matched = false;

  // "1 hora e meia" / "2 horas e 30"
  const compound = text.match(/(\d+)\s*(?:h|horas?)\s*e\s*(meia|\d+)/);
  if (compound) {
    total += Number(compound[1]) * 3600000;
    total += compound[2] === 'meia' ? 1800000 : Number(compound[2]) * 60000;
    return total;
  }

  for (const [regex, factor] of [
    [/(\d+)\s*(?:h|horas?)\b/, 3600000],
    [/(\d+)\s*(?:m|min|minutos?)\b/, 60000],
    [/(\d+)\s*(?:s|seg|segundos?)\b/, 1000],
  ]) {
    const match = text.match(regex);
    if (match) {
      total += Number(match[1]) * factor;
      matched = true;
    }
  }

  if (matched) return total;

  // Numero puro: interpreta como minutos, que e o que as pessoas querem dizer.
  const bare = text.match(/^(\d+)$/);
  if (bare) return Number(bare[1]) * 60000;

  return null;
}

/** Formata milissegundos como 1h 05m 30s / 05:30 / 30s. */
export function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  if (hours) return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
  if (minutes) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

/** Formato de relogio pro HUD: HH:MM:SS ou MM:SS. */
export function formatClock(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return hours ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/** Tempo decorrido de um cronometro, respeitando pausas. */
export function stopwatchElapsed(sw) {
  const base = sw.accumulatedMs || 0;
  if (sw.paused || sw.stoppedAt) return base;
  return base + (Date.now() - new Date(sw.resumedAt || sw.startedAt).getTime());
}

/**
 * Snapshot vivo pro HUD e pras respostas faladas. Calcula o restante na hora
 * em vez de guardar contador, entao nunca dessincroniza.
 */
export function timerSnapshot() {
  const state = load();
  const now = Date.now();

  return {
    timers: state.timers
      .filter((t) => !t.fired)
      .map((t) => {
        const remainingMs = new Date(t.endsAt).getTime() - now;
        return {
          id: t.id,
          label: t.label,
          kind: t.pomodoro ? 'pomodoro' : 'countdown',
          phase: t.pomodoro?.phase || null,
          cycle: t.pomodoro ? `${t.pomodoro.cycle}/${t.pomodoro.totalCycles}` : null,
          remainingMs,
          remaining: formatClock(remainingMs),
          durationMs: t.durationMs,
          progress: Math.min(1, Math.max(0, 1 - remainingMs / t.durationMs)),
          endsAt: t.endsAt,
        };
      })
      .sort((a, b) => a.remainingMs - b.remainingMs),

    stopwatches: state.stopwatches
      .filter((s) => !s.stoppedAt)
      .map((s) => {
        const elapsedMs = stopwatchElapsed(s);
        return {
          id: s.id,
          label: s.label,
          elapsedMs,
          elapsed: formatClock(elapsedMs),
          paused: Boolean(s.paused),
          laps: s.laps.length,
        };
      }),
  };
}

/**
 * Dispara os timers vencidos. O daemon chama isso a cada segundo.
 * Pomodoro encadeia sozinho: fim do foco cria a pausa, fim da pausa cria o
 * proximo foco, ate fechar os ciclos.
 */
export async function checkDueTimers() {
  const state = load();
  const now = Date.now();
  const due = state.timers.filter((t) => !t.fired && new Date(t.endsAt).getTime() <= now);
  if (!due.length) return [];

  const announcements = [];

  for (const timer of due) {
    timer.fired = true;
    timer.firedAt = new Date().toISOString();

    let message;

    if (timer.pomodoro) {
      const { phase, cycle, totalCycles, workMs, breakMs } = timer.pomodoro;

      if (phase === 'work') {
        message = `Ciclo ${cycle} de ${totalCycles} fechado. Pausa de ${formatDuration(breakMs)}.`;
        state.timers.push({
          id: nextId(state.timers),
          label: timer.label,
          durationMs: breakMs,
          endsAt: new Date(now + breakMs).toISOString(),
          fired: false,
          alarm: true,
          createdAt: new Date().toISOString(),
          pomodoro: { phase: 'break', cycle, totalCycles, workMs, breakMs },
        });
      } else if (cycle < totalCycles) {
        message = `Pausa acabou. Ciclo ${cycle + 1} de ${totalCycles}, ${formatDuration(workMs)} de foco.`;
        state.timers.push({
          id: nextId(state.timers),
          label: timer.label,
          durationMs: workMs,
          endsAt: new Date(now + workMs).toISOString(),
          fired: false,
          alarm: true,
          createdAt: new Date().toISOString(),
          pomodoro: { phase: 'work', cycle: cycle + 1, totalCycles, workMs, breakMs },
        });
      } else {
        message = `Pomodoro completo. ${totalCycles} ciclos de ${timer.label}.`;
      }
    } else {
      message = timer.label ? `${timer.label}: tempo esgotado.` : 'Tempo esgotado.';
    }

    // A notificacao nao pode impedir o timer de ser marcado como disparado:
    // se ela falhar e a gente propagar, o timer vence de novo no proximo tick
    // e fica repetindo pra sempre.
    try {
      await toast(config.nome, message);
      if (timer.alarm) await tocarAlarme();
    } catch {
      // Segue em frente — quem chamou ainda recebe o anuncio pra falar.
    }
    appendDaily('Timer', message);
    announcements.push({ ...timer, message });
  }

  // Mantem so os 50 timers mais recentes pro arquivo nao crescer sem fim.
  state.timers = state.timers.slice(-50);
  save(state);
  return announcements;
}

export default {
  name: 'timer',
  // '*' de proposito: iniciar/cancelar/consultar timer e cronometro so mexe no
  // vault (load/save) — roda igual na nuvem e no PC, e e o que faz a contagem
  // aparecer no HUD. O que e de Windows (tocar o alarme quando vence) mora em
  // checkDueTimers/tocarAlarme, chamado so pelo daemon do PC; na nuvem esse
  // caminho nunca roda, entao carregar a skill aqui e seguro.
  platform: '*',
  description: 'Timers de contagem regressiva, cronometros e pomodoro.',
  tools: [
    {
      name: 'start_timer',
      speaks: true,
      description:
        'Inicia uma contagem regressiva. Aceita duracao falada: "5 minutos", "1 hora e meia", ' +
        '"90 segundos", "meia hora". Use pra "poe 10 minutos", "marca 8 minutos pra massa".',
      input_schema: {
        type: 'object',
        properties: {
          duration: { type: 'string', description: 'Ex: "10 minutos", "1h30", "meia hora".' },
          label: { type: 'string', description: 'Do que e o timer. Ex: "massa", "forno", "call".' },
          alarm: { type: 'boolean', description: 'Toca beep alem da notificacao. Padrao true.' },
        },
        required: ['duration'],
      },
      handler: async ({ duration, label, alarm = true }) => {
        const ms = parseDuration(duration);
        if (!ms) return `Nao entendi a duracao "${duration}". Tente "10 minutos" ou "1 hora e meia".`;
        if (ms < 1000) return 'Duracao curta demais.';

        const state = load();
        const timer = {
          id: nextId(state.timers),
          label: label || null,
          durationMs: ms,
          endsAt: new Date(Date.now() + ms).toISOString(),
          fired: false,
          alarm,
          createdAt: new Date().toISOString(),
        };
        state.timers.push(timer);
        save(state);

        return `Timer de ${formatDuration(ms)}${label ? ` pra ${label}` : ''} rodando.`;
      },
    },
    {
      name: 'start_stopwatch',
      speaks: true,
      description:
        'Inicia um cronometro (conta pra cima, sem fim). Use pra "comeca a contar", ' +
        '"cronometra isso", "quanto tempo eu levo".',
      input_schema: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Do que e. Ex: "estudo", "treino", "call com cliente".' },
        },
      },
      handler: async ({ label }) => {
        const state = load();
        const running = state.stopwatches.find(
          (s) => !s.stoppedAt && (!label || s.label?.toLowerCase() === label.toLowerCase())
        );
        if (running) {
          return `Ja tem um cronometro rodando${running.label ? ` (${running.label})` : ''}, em ${formatClock(stopwatchElapsed(running))}.`;
        }

        state.stopwatches.push({
          id: nextId(state.stopwatches),
          label: label || null,
          startedAt: new Date().toISOString(),
          resumedAt: null,
          accumulatedMs: 0,
          paused: false,
          stoppedAt: null,
          laps: [],
        });
        save(state);
        return `Cronometro${label ? ` de ${label}` : ''} zerado e contando.`;
      },
    },
    {
      name: 'stopwatch_control',
      speaks: true,
      description:
        'Pausa, retoma, marca volta ou para um cronometro. ' +
        'Parar devolve o tempo total e registra no vault.',
      input_schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['pause', 'resume', 'lap', 'stop'] },
          label: { type: 'string', description: 'Qual cronometro. Sem isso, usa o unico rodando.' },
        },
        required: ['action'],
      },
      handler: async ({ action, label }) => {
        const state = load();
        const candidates = state.stopwatches.filter((s) => !s.stoppedAt);
        if (!candidates.length) return 'Nenhum cronometro rodando.';

        const sw = label
          ? candidates.find((s) => s.label?.toLowerCase().includes(label.toLowerCase()))
          : candidates[candidates.length - 1];
        if (!sw) return `Nao achei cronometro "${label}".`;

        const elapsed = stopwatchElapsed(sw);
        const name = sw.label ? ` de ${sw.label}` : '';

        switch (action) {
          case 'pause':
            if (sw.paused) return `O cronometro${name} ja esta pausado em ${formatClock(elapsed)}.`;
            sw.accumulatedMs = elapsed;
            sw.paused = true;
            save(state);
            return `Pausado em ${formatClock(elapsed)}.`;

          case 'resume':
            if (!sw.paused) return `O cronometro${name} ja esta correndo.`;
            sw.paused = false;
            sw.resumedAt = new Date().toISOString();
            save(state);
            return `Retomado de ${formatClock(elapsed)}.`;

          case 'lap':
            sw.laps.push({ at: new Date().toISOString(), elapsedMs: elapsed });
            save(state);
            return `Volta ${sw.laps.length}: ${formatClock(elapsed)}.`;

          case 'stop': {
            sw.accumulatedMs = elapsed;
            sw.stoppedAt = new Date().toISOString();
            save(state);
            appendDaily('Cronometro', `${sw.label || 'sem nome'} — ${formatDuration(elapsed)}`);
            const laps = sw.laps.length
              ? ` ${sw.laps.length} voltas: ${sw.laps.map((l) => formatClock(l.elapsedMs)).join(', ')}.`
              : '';
            return `Parado em ${formatDuration(elapsed)}.${laps}`;
          }

          default:
            return 'Acao desconhecida.';
        }
      },
    },
    {
      name: 'start_pomodoro',
      speaks: true,
      description:
        'Inicia um ciclo pomodoro que se encadeia sozinho: foco, pausa, foco, pausa. ' +
        'Padrao 25 minutos de foco, 5 de pausa, 4 ciclos.',
      input_schema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'No que voce vai focar.' },
          work_minutes: { type: 'number', description: 'Padrao 25.' },
          break_minutes: { type: 'number', description: 'Padrao 5.' },
          cycles: { type: 'number', description: 'Padrao 4.' },
        },
      },
      handler: async ({ task, work_minutes = 25, break_minutes = 5, cycles = 4 }) => {
        const state = load();
        const workMs = work_minutes * 60000;
        const breakMs = break_minutes * 60000;

        state.timers.push({
          id: nextId(state.timers),
          label: task || 'foco',
          durationMs: workMs,
          endsAt: new Date(Date.now() + workMs).toISOString(),
          fired: false,
          alarm: true,
          createdAt: new Date().toISOString(),
          pomodoro: { phase: 'work', cycle: 1, totalCycles: cycles, workMs, breakMs },
        });
        save(state);
        appendDaily('Pomodoro', `${cycles} ciclos de ${formatDuration(workMs)} — ${task || 'foco'}`);

        return `Pomodoro iniciado: ${formatDuration(workMs)} de foco${task ? ` em ${task}` : ''}, ${cycles} ciclos.`;
      },
    },
    {
      name: 'check_timers',
      speaks: true,
      description:
        'Diz quanto falta nos timers e quanto ja correu nos cronometros. ' +
        'Use pra "quanto falta", "quanto tempo ja passou", "como ta o timer".',
      input_schema: { type: 'object', properties: {} },
      handler: async () => {
        const { timers, stopwatches } = timerSnapshot();
        if (!timers.length && !stopwatches.length) return 'Nenhum timer ou cronometro ativo.';

        const lines = [];
        for (const t of timers) {
          const phase = t.phase === 'work' ? 'foco' : t.phase === 'break' ? 'pausa' : null;
          const detail = phase ? ` (${phase}, ciclo ${t.cycle})` : '';
          lines.push(`${t.label || 'timer'}${detail}: faltam ${t.remaining}`);
        }
        for (const s of stopwatches) {
          lines.push(`${s.label || 'cronometro'}: ${s.elapsed}${s.paused ? ' (pausado)' : ''}`);
        }
        return lines.join('\n');
      },
    },
    {
      name: 'cancel_timer',
      speaks: true,
      description: 'Cancela um timer, cronometro ou o pomodoro inteiro.',
      input_schema: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            description: 'Id, parte do nome, "todos", ou "pomodoro".',
          },
        },
        required: ['target'],
      },
      handler: async ({ target }) => {
        const state = load();
        const key = String(target).toLowerCase();

        if (key === 'todos' || key === 'tudo') {
          const count = state.timers.filter((t) => !t.fired).length +
            state.stopwatches.filter((s) => !s.stoppedAt).length;
          state.timers = state.timers.filter((t) => t.fired);
          for (const sw of state.stopwatches) if (!sw.stoppedAt) sw.stoppedAt = new Date().toISOString();
          save(state);
          return count ? `Cancelei ${count} timer(s).` : 'Nao havia nada rodando.';
        }

        if (key === 'pomodoro') {
          const before = state.timers.filter((t) => !t.fired && t.pomodoro).length;
          state.timers = state.timers.filter((t) => t.fired || !t.pomodoro);
          save(state);
          return before ? 'Pomodoro cancelado.' : 'Nao havia pomodoro rodando.';
        }

        const asId = Number(target);
        const timerIndex = Number.isInteger(asId)
          ? state.timers.findIndex((t) => t.id === asId && !t.fired)
          : state.timers.findIndex((t) => !t.fired && t.label?.toLowerCase().includes(key));

        if (timerIndex !== -1) {
          const [removed] = state.timers.splice(timerIndex, 1);
          save(state);
          return `Cancelei o timer${removed.label ? ` de ${removed.label}` : ''}.`;
        }

        const sw = state.stopwatches.find(
          (s) => !s.stoppedAt && (s.id === asId || s.label?.toLowerCase().includes(key))
        );
        if (sw) {
          sw.stoppedAt = new Date().toISOString();
          save(state);
          return `Cronometro${sw.label ? ` de ${sw.label}` : ''} cancelado.`;
        }

        return `Nao achei "${target}".`;
      },
    },
    // Hora e data saem da skill `relogio` (fala "oito e quarenta da noite" em
    // vez de "20:40", que a voz le torto). Nao dupliquei aqui de proposito:
    // duas tools de hora fazem o modelo pequeno escolher a de formato pior.
  ],
};
