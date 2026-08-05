import { startProcess, listProcesses, killProcess, ps, psQuote } from '../platform/win32.js';
import { config, loadJson, saveJson } from '../core/config.js';

/**
 * Skill: abrir/fechar aplicativos.
 *
 * O apelido -> alvo mora em config/apps.json pra voce editar sem mexer em codigo.
 * O alvo pode ser: nome de .exe no PATH, caminho absoluto, URI de app
 * (spotify:, discord:) ou um AppUserModelID de app da Store.
 */

function appRegistry() {
  return loadJson(config.paths.apps, {});
}

function resolveApp(name) {
  const registry = appRegistry();
  const key = name.toLowerCase().trim();

  if (registry[key]) return registry[key];

  // Match parcial: "code" acha "vscode", "vs code" acha "vscode".
  const stripped = key.replace(/[^a-z0-9]/g, '');
  for (const [alias, target] of Object.entries(registry)) {
    const aliasStripped = alias.replace(/[^a-z0-9]/g, '');
    if (aliasStripped === stripped || aliasStripped.includes(stripped) || stripped.includes(aliasStripped)) {
      return target;
    }
  }
  return null;
}

export default {
  name: 'apps',
  description: 'Abrir e fechar aplicativos do Windows.',
  tools: [
    {
      name: 'open_app',
      description:
        'Abre um aplicativo pelo apelido (discord, vscode, spotify, chrome, steam...). ' +
        'Opcionalmente abre com um arquivo ou pasta como argumento. ' +
        'Se o app nao estiver no registro, tenta abrir pelo nome direto.',
      input_schema: {
        type: 'object',
        properties: {
          app: { type: 'string', description: 'Apelido ou nome do app. Ex: "discord", "vscode".' },
          argument: {
            type: 'string',
            description: 'Arquivo, pasta ou URL pra abrir junto. Ex: um caminho de projeto pro VS Code.',
          },
        },
        required: ['app'],
      },
      handler: async ({ app, argument }) => {
        const target = resolveApp(app) || app;
        const args = argument ? [argument] : [];
        const result = await startProcess(target, args);
        if (!result.ok) {
          return `Falhou ao abrir "${app}" (alvo: ${target}). ${result.stderr}. ` +
            `Se o app existe mas nao esta mapeado, adicione em config/apps.json.`;
        }
        return `Abri ${app}${argument ? ` com ${argument}` : ''}.`;
      },
    },
    {
      name: 'close_app',
      description:
        'Fecha um aplicativo pelo nome do processo. Operacao destrutiva: confirme com o usuario antes.',
      input_schema: {
        type: 'object',
        properties: {
          process_name: {
            type: 'string',
            description: 'Nome do processo sem .exe. Ex: "Discord", "Code", "Spotify".',
          },
        },
        required: ['process_name'],
      },
      handler: async ({ process_name }) => {
        const result = await killProcess(process_name.replace(/\.exe$/i, ''));
        if (!result.ok) return `Nao consegui fechar "${process_name}": ${result.stderr}`;
        return `Fechei ${process_name}.`;
      },
    },
    {
      name: 'list_running_apps',
      description: 'Lista os processos rodando. Sem filtro, devolve os 20 que mais consomem memoria.',
      input_schema: {
        type: 'object',
        properties: {
          filter: { type: 'string', description: 'Filtro parcial pelo nome do processo.' },
        },
      },
      handler: async ({ filter }) => {
        const { ok, data, error } = await listProcesses(filter);
        if (!ok) return `Erro ao listar processos: ${error}`;
        if (!data) return 'Nenhum processo encontrado.';
        const rows = Array.isArray(data) ? data : [data];
        return rows.map((p) => `${p.ProcessName} (pid ${p.Id}, ${p.MemMB} MB)`).join('\n');
      },
    },
    {
      name: 'focus_window',
      description: 'Traz a janela de um app que ja esta aberto pra frente, sem reabrir.',
      input_schema: {
        type: 'object',
        properties: {
          process_name: { type: 'string', description: 'Nome do processo. Ex: "Discord".' },
        },
        required: ['process_name'],
      },
      handler: async ({ process_name }) => {
        const name = process_name.replace(/\.exe$/i, '');
        const script = `
Add-Type -Name JWin -Namespace Jarvis -MemberDefinition @"
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
"@
$p = Get-Process -Name ${psQuote(name)} -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if ($null -eq $p) { Write-Error 'Sem janela visivel'; exit 1 }
[Jarvis.JWin]::ShowWindow($p.MainWindowHandle, 9) | Out-Null
[Jarvis.JWin]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
`;
        const result = await ps(script);
        if (!result.ok) return `Nao achei janela de "${process_name}" pra focar.`;
        return `Trouxe ${process_name} pra frente.`;
      },
    },
    {
      name: 'register_app',
      description:
        'Salva um novo apelido de app em config/apps.json. Use quando o usuario disser onde um app fica.',
      input_schema: {
        type: 'object',
        properties: {
          alias: { type: 'string', description: 'Como o usuario chama o app. Ex: "obsidian".' },
          target: {
            type: 'string',
            description: 'Executavel, caminho completo ou URI. Ex: "C:/Apps/Obsidian.exe".',
          },
        },
        required: ['alias', 'target'],
      },
      handler: async ({ alias, target }) => {
        const registry = appRegistry();
        registry[alias.toLowerCase().trim()] = target;
        saveJson(config.paths.apps, registry);
        return `Registrei "${alias}" apontando pra ${target}.`;
      },
    },
  ],
};
