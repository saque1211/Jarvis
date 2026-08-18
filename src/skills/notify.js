import fs from 'node:fs';
import path from 'node:path';
import { toast, ps, psQuote } from '../platform/win32.js';
import { config, ensureDirs } from '../core/config.js';
import { appendDaily } from '../core/vault.js';

/**
 * Skill: notificacoes e lembretes.
 *
 * Os lembretes ficam em disco, entao sobrevivem a reinicio do JARVIS. Quem
 * dispara e o daemon de voz (checkDueReminders roda a cada 30s la); assim
 * nao existe um segundo processo agendador pra manter vivo.
 */

function remindersFile() {
  ensureDirs();
  return path.join(config.vaultPath, 'tasks', 'reminders.json');
}

function load() {
  const file = remindersFile();
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

function save(reminders) {
  fs.writeFileSync(remindersFile(), JSON.stringify(reminders, null, 2), 'utf8');
}

/**
 * Converte tempo falado em timestamp. Cobre os formatos que a voz produz:
 * "em 10 minutos", "as 15:30", "amanha as 9", "daqui a 2 horas".
 */
export function parseWhen(input) {
  const text = String(input).toLowerCase().trim();
  const now = new Date();

  const relative = text.match(/(?:em|daqui a)\s+(\d+)\s*(segundos?|minutos?|min|horas?|h|dias?)/);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2];
    const ms = unit.startsWith('seg') ? amount * 1000
      : unit.startsWith('min') ? amount * 60000
      : unit.startsWith('h') ? amount * 3600000
      : amount * 86400000;
    return new Date(now.getTime() + ms);
  }

  const clock = text.match(/(?:as|às)?\s*(\d{1,2})(?::(\d{2}))?\s*(?:h|horas)?/);
  if (clock) {
    const hour = Number(clock[1]);
    const minute = Number(clock[2] || 0);
    if (hour <= 23) {
      const target = new Date(now);
      const tomorrow = text.includes('amanh');
      target.setHours(hour, minute, 0, 0);
      if (tomorrow || target <= now) target.setDate(target.getDate() + 1);
      return target;
    }
  }

  const iso = new Date(input);
  return Number.isNaN(iso.getTime()) ? null : iso;
}

/**
 * Dispara os lembretes vencidos. O daemon chama isso em loop.
 * Devolve os lembretes que foram disparados, pra quem chamou poder falar.
 */
export async function checkDueReminders() {
  const reminders = load();
  const now = Date.now();
  const due = reminders.filter((r) => !r.fired && new Date(r.when).getTime() <= now);
  if (!due.length) return [];

  for (const reminder of due) {
    reminder.fired = true;
    reminder.firedAt = new Date().toISOString();
    // Marca como disparado ANTES de notificar: se o toast falhar e a excecao
    // subir, o lembrete venceria de novo no proximo tick, pra sempre.
    try {
      await toast(config.nome, reminder.message);
    } catch {
      // O daemon ainda fala a mensagem mesmo sem o toast visual.
    }
    appendDaily('Lembrete disparado', reminder.message);
  }

  // Mantem so os 100 mais recentes pra lista nao crescer pra sempre.
  save(reminders.slice(-100));
  return due;
}

export default {
  name: 'notify',
  // Controla a maquina local: so faz sentido onde ela esta. O servidor na
  // nuvem carrega o registro sem estas, e o agente do PC carrega so estas.
  platform: 'win32',
  description: 'Lembretes, alarmes, deadlines e notificacoes do Windows.',
  tools: [
    {
      name: 'set_reminder',
      speaks: true,
      description:
        'Cria um lembrete que dispara uma notificacao do Windows na hora certa. ' +
        'Aceita tempo falado: "em 10 minutos", "as 15:30", "amanha as 9".',
      input_schema: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'O que lembrar.' },
          when: { type: 'string', description: 'Quando. Ex: "em 20 minutos", "as 18h".' },
        },
        required: ['message', 'when'],
      },
      handler: async ({ message, when }) => {
        const target = parseWhen(when);
        if (!target) return `Nao entendi o horario "${when}". Tente "em 10 minutos" ou "as 15:30".`;
        if (target.getTime() <= Date.now()) return 'Esse horario ja passou.';

        const reminders = load();
        const reminder = {
          id: reminders.reduce((m, r) => Math.max(m, r.id || 0), 0) + 1,
          message,
          when: target.toISOString(),
          fired: false,
          createdAt: new Date().toISOString(),
        };
        reminders.push(reminder);
        save(reminders);

        const time = target.toLocaleString('pt-BR', {
          hour: '2-digit',
          minute: '2-digit',
          day: '2-digit',
          month: '2-digit',
        });
        appendDaily('Lembrete criado', `${message} — ${time}`);
        return `Lembrete marcado pra ${time}: ${message}.`;
      },
    },
    {
      name: 'list_reminders',
      description: 'Lista os lembretes pendentes.',
      input_schema: { type: 'object', properties: {} },
      handler: async () => {
        const pending = load()
          .filter((r) => !r.fired)
          .sort((a, b) => new Date(a.when) - new Date(b.when));
        if (!pending.length) return 'Nenhum lembrete pendente.';
        return pending
          .map((r) => {
            const time = new Date(r.when).toLocaleString('pt-BR', {
              day: '2-digit',
              month: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
            });
            return `${r.id}. ${time} — ${r.message}`;
          })
          .join('\n');
      },
    },
    {
      name: 'cancel_reminder',
      speaks: true,
      description: 'Cancela um lembrete pendente pelo id ou por parte da mensagem.',
      input_schema: {
        type: 'object',
        properties: { identifier: { type: 'string' } },
        required: ['identifier'],
      },
      handler: async ({ identifier }) => {
        const reminders = load();
        const asId = Number(identifier);
        const index = Number.isInteger(asId)
          ? reminders.findIndex((r) => r.id === asId && !r.fired)
          : reminders.findIndex(
              (r) => !r.fired && r.message.toLowerCase().includes(String(identifier).toLowerCase())
            );

        if (index === -1) return `Nao achei o lembrete "${identifier}".`;
        const [removed] = reminders.splice(index, 1);
        save(reminders);
        return `Cancelei: ${removed.message}.`;
      },
    },
    {
      name: 'notify_now',
      speaks: true,
      description: 'Mostra uma notificacao do Windows agora, sem agendar.',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Padrao: JARVIS.' },
          message: { type: 'string' },
        },
        required: ['message'],
      },
      handler: async ({ title = 'JARVIS', message }) => {
        const result = await toast(title, message);
        return result.ok ? 'Notificacao enviada.' : `Falhou: ${result.stderr}`;
      },
    },
    {
      name: 'set_alarm',
      speaks: true,
      description:
        'Alarme sonoro: notifica e toca um beep repetido. Use quando o usuario quer ser interrompido ' +
        'de verdade, nao so avisado.',
      input_schema: {
        type: 'object',
        properties: {
          message: { type: 'string' },
          when: { type: 'string', description: 'Ex: "em 25 minutos" (pomodoro), "as 7h".' },
        },
        required: ['message', 'when'],
      },
      handler: async ({ message, when }) => {
        const target = parseWhen(when);
        if (!target) return `Nao entendi "${when}".`;

        const reminders = load();
        reminders.push({
          id: reminders.reduce((m, r) => Math.max(m, r.id || 0), 0) + 1,
          message,
          when: target.toISOString(),
          alarm: true,
          fired: false,
          createdAt: new Date().toISOString(),
        });
        save(reminders);

        const time = target.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        return `Alarme pras ${time}: ${message}.`;
      },
    },
    {
      name: 'beep',
      description: 'Toca um beep na maquina. Util pra sinalizar fim de build longo.',
      input_schema: {
        type: 'object',
        properties: {
          times: { type: 'number', description: 'Quantos beeps. Padrao 2.' },
        },
      },
      handler: async ({ times = 2 }) => {
        await ps(`for ($i=0; $i -lt ${Number(times)}; $i++) { [console]::beep(880, 200); Start-Sleep -Milliseconds 150 }`);
        return 'Beep.';
      },
    },
  ],
};
