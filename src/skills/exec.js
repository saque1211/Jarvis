import fs from 'node:fs';
import path from 'node:path';
import { run, ps } from '../platform/win32.js';
import { config, loadJson, saveJson } from '../core/config.js';
import { appendDaily } from '../core/vault.js';

/**
 * Skill: rodar scripts e automacoes.
 *
 * Duas portas, de proposito:
 *  - run_saved_script: roda algo que VOCE ja cadastrou. Seguro, previsivel.
 *  - run_command: linha de comando arbitraria. Passa por checagem de padroes
 *    destrutivos e exige confirmacao antes de executar.
 */

// Padroes que nunca rodam sem o usuario confirmar em voz/texto.
const DESTRUCTIVE = [
  /\brm\b.*-[a-z]*r/i,
  /\bRemove-Item\b.*-Recurse/i,
  /\bformat\b/i,
  /\bdel\b\s+\/[sq]/i,
  /\bdiskpart\b/i,
  /\bmkfs\b/i,
  /\bshutdown\b/i,
  /\bReset-Computer\b/i,
  /git\s+push\s+.*--force/i,
  /git\s+reset\s+--hard/i,
  /\bdd\b\s+if=/i,
  />\s*\/dev\/sd/i,
];

function isDestructive(command) {
  return DESTRUCTIVE.some((re) => re.test(command));
}

function scriptRegistry() {
  return loadJson(path.join(config.root, 'config', 'scripts.json'), {});
}

export default {
  name: 'exec',
  // Controla a maquina local: so faz sentido onde ela esta. O servidor na
  // nuvem carrega o registro sem estas, e o agente do PC carrega so estas.
  platform: 'win32',
  description: 'Rodar scripts Python, comandos PowerShell/bash e automacoes salvas.',
  tools: [
    {
      name: 'run_saved_script',
      description:
        'Roda um script previamente cadastrado em config/scripts.json pelo apelido. ' +
        'Prefira esta tool a run_command quando o usuario mencionar uma automacao dele.',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Apelido do script cadastrado.' },
          args: {
            type: 'array',
            items: { type: 'string' },
            description: 'Argumentos extras passados pro script.',
          },
        },
        required: ['name'],
      },
      handler: async ({ name, args = [] }) => {
        const registry = scriptRegistry();
        const entry = registry[name.toLowerCase().trim()];
        if (!entry) {
          const available = Object.keys(registry);
          return available.length
            ? `Nao conheco o script "${name}". Cadastrados: ${available.join(', ')}.`
            : `Nenhum script cadastrado ainda. Use save_script pra registrar o primeiro.`;
        }

        const result = await run(entry.command, [...(entry.args || []), ...args], {
          cwd: entry.cwd,
          timeoutMs: entry.timeoutMs,
        });
        appendDaily('Script', `Rodei \`${name}\` — exit ${result.code}`);
        const output = [result.stdout, result.stderr].filter(Boolean).join('\n').slice(0, 4000);
        return `exit ${result.code}\n${output || '(sem saida)'}`;
      },
    },
    {
      name: 'run_command',
      description:
        'Roda um comando arbitrario no PowerShell. Use pra tarefas pontuais que nao tem script salvo. ' +
        'Comandos destrutivos sao bloqueados ate o usuario confirmar explicitamente — ' +
        'nesse caso pergunte antes e so entao chame de novo com confirmed=true.',
      input_schema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Linha de comando PowerShell.' },
          cwd: { type: 'string', description: 'Diretorio de trabalho.' },
          confirmed: {
            type: 'boolean',
            description: 'Marque true so depois que o usuario aprovar um comando destrutivo.',
          },
        },
        required: ['command'],
      },
      handler: async ({ command, cwd, confirmed }) => {
        if (isDestructive(command) && !confirmed && config.safety.confirmDestructive) {
          return (
            `BLOQUEADO — comando parece destrutivo: ${command}\n` +
            'Pergunte ao usuario se pode rodar. Se ele autorizar, chame de novo com confirmed=true.'
          );
        }
        const result = await ps(command, { cwd });
        appendDaily('Comando', `\`${command}\` — exit ${result.code}`);
        const output = [result.stdout, result.stderr].filter(Boolean).join('\n').slice(0, 4000);
        return `exit ${result.code}\n${output || '(sem saida)'}`;
      },
    },
    {
      name: 'run_python',
      description: 'Roda um arquivo Python. Caminho relativo resolve a partir da raiz do JARVIS.',
      input_schema: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'Caminho do .py.' },
          args: { type: 'array', items: { type: 'string' } },
          python: { type: 'string', description: 'Interpretador. Padrao: python.' },
        },
        required: ['file'],
      },
      handler: async ({ file, args = [], python = 'python' }) => {
        const full = path.isAbsolute(file) ? file : path.resolve(config.root, file);
        if (!fs.existsSync(full)) return `Arquivo nao existe: ${full}`;
        const result = await run(python, [full, ...args]);
        const output = [result.stdout, result.stderr].filter(Boolean).join('\n').slice(0, 4000);
        return `exit ${result.code}\n${output || '(sem saida)'}`;
      },
    },
    {
      name: 'save_script',
      description: 'Cadastra um script/automacao com apelido pra rodar depois por voz.',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Apelido curto. Ex: "backup", "limpar downloads".' },
          command: { type: 'string', description: 'Executavel. Ex: "python", "node", "pwsh".' },
          args: { type: 'array', items: { type: 'string' }, description: 'Argumentos fixos.' },
          cwd: { type: 'string', description: 'Diretorio de trabalho.' },
        },
        required: ['name', 'command'],
      },
      handler: async ({ name, command, args = [], cwd }) => {
        const file = path.join(config.root, 'config', 'scripts.json');
        const registry = loadJson(file, {});
        registry[name.toLowerCase().trim()] = { command, args, cwd };
        saveJson(file, registry);
        return `Salvei o script "${name}".`;
      },
    },
    {
      name: 'schedule_task',
      description:
        'Cria uma tarefa agendada do Windows que roda um comando de tempos em tempos. ' +
        'Use pra automacoes recorrentes de verdade (backup diario, limpeza semanal).',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Nome da tarefa.' },
          command: { type: 'string', description: 'Comando completo a rodar.' },
          schedule: {
            type: 'string',
            enum: ['DAILY', 'WEEKLY', 'HOURLY', 'ONLOGON'],
            description: 'Frequencia.',
          },
          time: { type: 'string', description: 'Horario HH:mm para DAILY/WEEKLY.' },
        },
        required: ['name', 'command', 'schedule'],
      },
      handler: async ({ name, command, schedule, time }) => {
        const args = [
          '/Create',
          '/TN', `JARVIS\\${name}`,
          '/TR', `powershell.exe -NoProfile -Command "${command.replace(/"/g, '\\"')}"`,
          '/SC', schedule,
          '/F',
        ];
        if (time && ['DAILY', 'WEEKLY'].includes(schedule)) args.push('/ST', time);
        const result = await run('schtasks.exe', args);
        if (!result.ok) return `Falhou ao agendar: ${result.stderr || result.stdout}`;
        return `Agendei "${name}" pra rodar ${schedule}${time ? ` as ${time}` : ''}.`;
      },
    },
    {
      name: 'list_scheduled_tasks',
      description: 'Lista as tarefas agendadas criadas pelo JARVIS.',
      input_schema: { type: 'object', properties: {} },
      handler: async () => {
        const result = await run('schtasks.exe', ['/Query', '/TN', 'JARVIS', '/FO', 'LIST']);
        return result.stdout || 'Nenhuma tarefa agendada pelo JARVIS.';
      },
    },
  ],
};
