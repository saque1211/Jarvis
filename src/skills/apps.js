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

/**
 * Tira acento antes de tirar pontuacao. Na ordem contraria, "discordia" vira
 * "discrdia" — a vogal acentuada some junto com a pontuacao e o match morre.
 */
function normalizar(texto) {
  return texto
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/** Levenshtein. Duas linhas de matriz bastam e o registro e pequeno. */
function distancia(a, b) {
  if (a === b) return 0;
  if (!a.length || !b.length) return Math.max(a.length, b.length);

  let anterior = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const atual = [i];
    for (let j = 1; j <= b.length; j++) {
      atual[j] = Math.min(
        anterior[j] + 1,
        atual[j - 1] + 1,
        anterior[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    anterior = atual;
  }
  return anterior[b.length];
}

/**
 * Quanto erro tolerar. Palavra curta erra por acaso: em 3 letras, distancia 1
 * ja transforma "obs" em "abs". Quanto mais longa, mais seguro relevar.
 */
function tolerancia(tamanho) {
  if (tamanho <= 4) return 0;
  if (tamanho <= 7) return 2;
  return 3;
}

/**
 * Resolve o apelido falado no alvo real. Devolve tambem o apelido canonico,
 * pra resposta confirmar o que ele entendeu — "abre o discordia" responde
 * "Abri o discord", e voce percebe na hora se ele pegou o app errado.
 *
 * A transcricao de voz erra letra: sem tolerar isso, "discordia" custa o
 * comando inteiro so porque o whisper ouviu uma silaba a mais.
 */
function resolveApp(name) {
  const registry = appRegistry();
  const key = name.toLowerCase().trim();
  if (registry[key]) return { target: registry[key], alias: key };

  const alvo = normalizar(name);
  if (!alvo) return null;

  const entradas = Object.entries(registry).map(([alias, target]) => ({
    alias,
    target,
    norm: normalizar(alias),
  }));

  const exato = entradas.find((e) => e.norm === alvo);
  if (exato) return { target: exato.target, alias: exato.alias };

  // Match parcial: "code" acha "vscode". So com 4+ letras — abaixo disso
  // "obs" casaria com "obsidian" e "cmd" com qualquer coisa que os contenha.
  const parcial = entradas.find(
    (e) =>
      (e.norm.length >= 4 && alvo.includes(e.norm)) ||
      (alvo.length >= 4 && e.norm.includes(alvo))
  );
  if (parcial) return { target: parcial.target, alias: parcial.alias };

  // Ultimo recurso: o mais parecido, se estiver perto o bastante.
  let melhor = null;
  for (const e of entradas) {
    const d = distancia(alvo, e.norm);
    if (d <= tolerancia(Math.max(alvo.length, e.norm.length)) && (!melhor || d < melhor.d)) {
      melhor = { ...e, d };
    }
  }
  return melhor ? { target: melhor.target, alias: melhor.alias } : null;
}

export default {
  name: 'apps',
  description: 'Abrir e fechar aplicativos do Windows.',
  tools: [
    {
      name: 'open_app',
      speaks: true,
      description:
        'Abre um aplicativo pelo apelido (discord, vscode, spotify, chrome, steam...). ' +
        'Use pra "abre o X", "inicia o X", "poe o X pra rodar". ' +
        'Pode passar o nome como o usuario falou, mesmo torto: erro de transcricao ' +
        'e resolvido aqui ("discordia" abre o Discord). Nao tente adivinhar o ' +
        'executavel. Opcionalmente abre com um arquivo ou pasta como argumento.',
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
        const achado = resolveApp(app);
        const target = achado?.target || app;
        const args = argument ? [argument] : [];
        const result = await startProcess(target, args);
        if (!result.ok) {
          // Sem apelido parecido, o nome veio de uma transcricao que errou
          // feio. Listar o que existe deixa o modelo tentar de novo com um
          // nome de verdade em vez de repetir o mesmo erro.
          if (!achado) {
            const conhecidos = Object.keys(appRegistry()).slice(0, 12).join(', ');
            return (
              `Nao conheco nenhum app parecido com "${app}". Conheco: ${conhecidos}. ` +
              `Se for um app novo, use register_app pra salvar o apelido e o caminho.`
            );
          }
          return `Falhou ao abrir "${achado.alias}" (alvo: ${target}). ${result.stderr}.`;
        }
        // Fala o nome canonico, nao o que foi transcrito: se a voz virou
        // "discordia" e ele abriu o Discord, voce ouve "Abri discord" e sabe
        // que acertou. Ouvir a propria palavra errada de volta nao diz nada.
        return `Abri ${achado?.alias || app}${argument ? ` com ${argument}` : ''}.`;
      },
    },
    {
      name: 'close_app',
      speaks: true,
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
      speaks: true,
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
      speaks: true,
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
