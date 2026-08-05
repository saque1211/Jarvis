import fs from 'node:fs';
import path from 'node:path';
import { config, ensureDirs } from '../core/config.js';
import { appendDaily, writeNote, today } from '../core/vault.js';

/**
 * Skill: tarefas e anotacoes.
 *
 * As tarefas ficam num unico JSON pra facilitar consulta, mas toda mudanca
 * tambem e espelhada no log markdown do dia — o vault continua legivel sem
 * o JARVIS aberto.
 */

function tasksFile() {
  ensureDirs();
  return path.join(config.vaultPath, 'tasks', 'tasks.json');
}

function loadTasks() {
  const file = tasksFile();
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

function saveTasks(tasks) {
  fs.writeFileSync(tasksFile(), JSON.stringify(tasks, null, 2), 'utf8');
}

function nextId(tasks) {
  return tasks.reduce((max, t) => Math.max(max, t.id), 0) + 1;
}

/** Interpreta datas relativas em portugues que a voz costuma produzir. */
function parseDue(input) {
  if (!input) return null;
  const text = String(input).toLowerCase().trim();
  const now = new Date();

  const dayFromNow = (n) => {
    const d = new Date(now);
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  };

  if (['hoje', 'today'].includes(text)) return dayFromNow(0);
  if (['amanha', 'amanhã', 'tomorrow'].includes(text)) return dayFromNow(1);
  if (text.includes('depois de amanh')) return dayFromNow(2);
  if (text.includes('semana que vem') || text.includes('proxima semana')) return dayFromNow(7);

  const inDays = text.match(/em (\d+) dias?/);
  if (inDays) return dayFromNow(Number(inDays[1]));

  // Formato ISO ja pronto.
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;

  // dd/mm ou dd/mm/aaaa
  const br = text.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (br) {
    const [, d, m, y] = br;
    const year = y ? (y.length === 2 ? `20${y}` : y) : String(now.getFullYear());
    return `${year}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  return null;
}

export default {
  name: 'tasks',
  description: 'Criar e gerenciar to-dos, anotacoes e prioridades do dia.',
  tools: [
    {
      name: 'add_task',
      speaks: true,
      description:
        'Adiciona uma tarefa. Aceita prazo em linguagem natural ("amanha", "em 3 dias", "15/08").',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'O que precisa ser feito.' },
          due: { type: 'string', description: 'Prazo. Ex: "amanha", "em 3 dias", "2026-08-20".' },
          priority: { type: 'string', enum: ['alta', 'media', 'baixa'] },
          project: { type: 'string', description: 'Projeto ou contexto ao qual a tarefa pertence.' },
        },
        required: ['title'],
      },
      handler: async ({ title, due, priority = 'media', project }) => {
        const tasks = loadTasks();
        const task = {
          id: nextId(tasks),
          title,
          due: parseDue(due),
          priority,
          project: project || null,
          done: false,
          createdAt: new Date().toISOString(),
        };
        tasks.push(task);
        saveTasks(tasks);
        appendDaily('Tarefa criada', `- [ ] ${title}${task.due ? ` (prazo ${task.due})` : ''}`);
        return `Anotei: ${title}${task.due ? `, pra ${task.due}` : ''}. Id ${task.id}.`;
      },
    },
    {
      name: 'list_tasks',
      description: 'Lista tarefas. Por padrao mostra so as pendentes, com as atrasadas primeiro.',
      input_schema: {
        type: 'object',
        properties: {
          filter: {
            type: 'string',
            enum: ['pendentes', 'hoje', 'atrasadas', 'concluidas', 'todas'],
            description: 'Padrao: pendentes.',
          },
          project: { type: 'string' },
        },
      },
      handler: async ({ filter = 'pendentes', project }) => {
        let tasks = loadTasks();
        const hoje = today();

        if (project) {
          tasks = tasks.filter((t) => t.project?.toLowerCase() === project.toLowerCase());
        }

        switch (filter) {
          case 'pendentes':
            tasks = tasks.filter((t) => !t.done);
            break;
          case 'hoje':
            tasks = tasks.filter((t) => !t.done && t.due === hoje);
            break;
          case 'atrasadas':
            tasks = tasks.filter((t) => !t.done && t.due && t.due < hoje);
            break;
          case 'concluidas':
            tasks = tasks.filter((t) => t.done);
            break;
        }

        if (!tasks.length) return `Nenhuma tarefa (${filter}).`;

        const weight = { alta: 0, media: 1, baixa: 2 };
        tasks.sort((a, b) => {
          const aLate = a.due && a.due < hoje ? 0 : 1;
          const bLate = b.due && b.due < hoje ? 0 : 1;
          if (aLate !== bLate) return aLate - bLate;
          return weight[a.priority] - weight[b.priority];
        });

        return tasks
          .slice(0, 20)
          .map((t) => {
            const late = t.due && t.due < hoje && !t.done ? ' ATRASADA' : '';
            const when = t.due ? ` [${t.due}]` : '';
            const proj = t.project ? ` (${t.project})` : '';
            return `${t.id}. ${t.done ? '[x]' : '[ ]'} ${t.title}${when}${proj}${late}`;
          })
          .join('\n');
      },
    },
    {
      name: 'complete_task',
      speaks: true,
      description: 'Marca uma tarefa como concluida. Aceita o id ou parte do titulo.',
      input_schema: {
        type: 'object',
        properties: {
          identifier: { type: 'string', description: 'Id numerico ou trecho do titulo.' },
        },
        required: ['identifier'],
      },
      handler: async ({ identifier }) => {
        const tasks = loadTasks();
        const asId = Number(identifier);
        const task = Number.isInteger(asId)
          ? tasks.find((t) => t.id === asId)
          : tasks.find((t) => !t.done && t.title.toLowerCase().includes(String(identifier).toLowerCase()));

        if (!task) return `Nao achei a tarefa "${identifier}".`;
        task.done = true;
        task.completedAt = new Date().toISOString();
        saveTasks(tasks);
        appendDaily('Tarefa concluida', `- [x] ${task.title}`);
        return `Concluida: ${task.title}.`;
      },
    },
    {
      name: 'delete_task',
      speaks: true,
      description: 'Remove uma tarefa da lista.',
      input_schema: {
        type: 'object',
        properties: { identifier: { type: 'string', description: 'Id ou trecho do titulo.' } },
        required: ['identifier'],
      },
      handler: async ({ identifier }) => {
        const tasks = loadTasks();
        const asId = Number(identifier);
        const index = Number.isInteger(asId)
          ? tasks.findIndex((t) => t.id === asId)
          : tasks.findIndex((t) => t.title.toLowerCase().includes(String(identifier).toLowerCase()));

        if (index === -1) return `Nao achei a tarefa "${identifier}".`;
        const [removed] = tasks.splice(index, 1);
        saveTasks(tasks);
        return `Removi: ${removed.title}.`;
      },
    },
    {
      name: 'set_priorities',
      description:
        'Define as 3 prioridades do dia e grava no log. Use quando o usuario disser o que quer focar hoje.',
      input_schema: {
        type: 'object',
        properties: {
          priorities: {
            type: 'array',
            items: { type: 'string' },
            description: 'Ate 3 prioridades, em ordem.',
          },
        },
        required: ['priorities'],
      },
      handler: async ({ priorities }) => {
        const top = priorities.slice(0, 3);
        const body = top.map((p, i) => `${i + 1}. ${p}`).join('\n');
        appendDaily('Prioridades do dia', body);

        // Prioridades tambem viram tarefas de alta prioridade pra hoje.
        const tasks = loadTasks();
        for (const title of top) {
          tasks.push({
            id: nextId(tasks),
            title,
            due: today(),
            priority: 'alta',
            project: null,
            done: false,
            createdAt: new Date().toISOString(),
          });
        }
        saveTasks(tasks);
        return `Prioridades de hoje travadas: ${top.join('; ')}.`;
      },
    },
    {
      name: 'take_note',
      speaks: true,
      description:
        'Salva uma anotacao livre no vault. Use quando o usuario disser "anota ai", "lembra disso", ' +
        '"guarda essa ideia".',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Titulo curto da nota.' },
          body: { type: 'string', description: 'Conteudo completo.' },
        },
        required: ['title', 'body'],
      },
      handler: async ({ title, body }) => {
        const file = writeNote(title, body);
        appendDaily('Nota', `**${title}** → ${path.basename(file)}`);
        return `Anotado: ${title}.`;
      },
    },
  ],
};
