import {
  startProcess,
  listProcesses,
  killProcess,
  ps,
  psQuote,
  nomeDeProcesso,
  processoVivo,
} from '../platform/win32.js';
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
// Palavras que sobram da frase falada e nao nomeiam app nenhum. Sem tirar,
// "abre" ficaria a distancia 2 de "brave" e abriria o navegador sozinho.
const RUIDO = new Set([
  'abre', 'abrir', 'abra', 'fecha', 'fechar', 'inicia', 'iniciar', 'roda',
  'rodar', 'executa', 'executar', 'programa', 'aplicativo', 'app', 'agora',
  'favor', 'jarvis', 'quero', 'por', 'pra', 'para', 'com', 'meu', 'minha',
]);

function resolveApp(name) {
  const registry = appRegistry();
  const key = name.toLowerCase().trim();
  if (registry[key]) return { target: registry[key], alias: key };

  const alvo = normalizar(name);
  if (!alvo) return null;

  // O que foi falado tambem vira palavras. A transcricao gruda coisa que nao
  // e nome ("cloud design" pra Claude), e comparando so a frase inteira o
  // nome certo fica longe de tudo — "clouddesign" esta a 6 de "claude",
  // mas "cloud" esta a 2.
  const palavrasFaladas = name
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((p) => p.length >= 2 && !RUIDO.has(p))
    .map(normalizar)
    .filter((p) => p && p !== alvo);

  const candidatos = [alvo, ...palavrasFaladas];

  // Pra comparacao APROXIMADA so entram palavras de 4+ letras: em 3 letras,
  // uma diferenca ja troca a palavra inteira ("obs" vira "abs"). Na
  // comparacao EXATA nao ha esse risco, e por isso ali entram todas — e o
  // que faz "quero o obs studio" achar o OBS e nao o Visual Studio Code.
  const candidatosFuzzy = [alvo, ...palavrasFaladas.filter((p) => p.length >= 4)];

  const entradas = Object.entries(registry).map(([alias, target]) => ({
    alias,
    target,
    norm: normalizar(alias),
    // Nome composto tambem responde por cada palavra: "roblox player" precisa
    // atender por "roblox". Sem isso, o apelido que o Menu Iniciar da (quase
    // sempre com sobrenome) so funcionaria dito por inteiro.
    palavras: alias
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .map(normalizar)
      .filter(Boolean),
  }));

  const exato = entradas.find((e) => candidatos.includes(e.norm));
  if (exato) return { target: exato.target, alias: exato.alias };

  // Palavra inteira batendo com palavra inteira: "obs" acha "obs studio",
  // "quero o discord aberto" acha discord.
  //
  // Pegar o primeiro que bate nao serve: "obs studio" e "visual studio code"
  // tem "studio" em comum, e a palavra generica ganharia do nome especifico.
  // Entao vence quem casa MAIS palavras, e no empate a palavra mais longa —
  // "studio" sozinho e fraco, "obs" + "studio" e forte.
  const casados = entradas
    .map((e) => {
      const batem = e.palavras.filter((p) => candidatos.includes(p));
      return { e, quantas: batem.length, maior: Math.max(0, ...batem.map((p) => p.length)) };
    })
    .filter((x) => x.quantas > 0)
    .sort((a, b) => b.quantas - a.quantas || b.maior - a.maior);

  if (casados.length) {
    const melhor = casados[0];
    return { target: melhor.e.target, alias: melhor.e.alias };
  }

  // Match parcial dentro da palavra: "code" acha "vscode". So com 4+ letras —
  // abaixo disso "obs" casaria com "obsidian" e "cmd" com meio registro.
  const parcial = entradas.find(
    (e) =>
      (e.norm.length >= 4 && alvo.includes(e.norm)) ||
      (alvo.length >= 4 && e.norm.includes(alvo))
  );
  if (parcial) return { target: parcial.target, alias: parcial.alias };

  // Ultimo recurso: o mais parecido, comparando com o apelido inteiro e com
  // cada palavra dele. "robloks" erra dentro de "roblox", nao no "player".
  const perto = [];
  for (const e of entradas) {
    let melhorDaEntrada = Infinity;
    for (const falado of candidatosFuzzy) {
      for (const candidato of [e.norm, ...e.palavras]) {
        const d = distancia(falado, candidato);
        if (d <= tolerancia(Math.max(falado.length, candidato.length))) {
          melhorDaEntrada = Math.min(melhorDaEntrada, d);
        }
      }
    }
    if (melhorDaEntrada < Infinity) perto.push({ ...e, d: melhorDaEntrada });
  }
  if (!perto.length) return null;

  const menor = Math.min(...perto.map((e) => e.d));
  const empatados = perto.filter((e) => e.d === menor);

  // Empate entre apps DIFERENTES e cara ou coroa, e abrir o app errado com
  // confianca e pior que nao abrir: "estine" fica a 4 de steam, notion e edge.
  // Devolver nada faz o modelo perguntar, que e a saida honesta.
  // (Apelidos diferentes pro mesmo alvo — "estim" e "estima" — nao sao empate.)
  const alvosDistintos = new Set(empatados.map((e) => e.target));
  if (alvosDistintos.size > 1) return null;

  return { target: empatados[0].target, alias: empatados[0].alias };
}

/**
 * Os apelidos mais parecidos, ignorando a tolerancia. Serve pra quando nada
 * casou: sem candidatos de verdade o modelo inventa opcao ("voce quis dizer
 * Destination?" — nome que nao existe no registro), e a pessoa fica escolhendo
 * entre coisas que nao vao abrir.
 */
function sugestoes(name, quantas = 4) {
  const alvo = normalizar(name);
  if (!alvo) return [];

  const registry = appRegistry();
  const vistos = new Set();
  return Object.entries(registry)
    .map(([alias, target]) => ({ alias, target, d: distancia(alvo, normalizar(alias)) }))
    .sort((a, b) => a.d - b.d)
    // Um alvo aparece com varios apelidos (estim, istim, esteam -> Steam).
    // Oferecer os tres como opcoes diferentes nao ajuda ninguem a escolher.
    .filter((e) => !vistos.has(e.target) && vistos.add(e.target))
    .slice(0, quantas)
    .map((e) => e.alias);
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
            const perto = sugestoes(app);
            return (
              `Nao achei app com o nome "${app}". Os mais parecidos que tenho: ` +
              `${perto.join(', ')}. Pergunte ao usuario qual deles e — ` +
              `NAO invente outros nomes, so esses existem. Se for um app novo, ` +
              `use register_app com o apelido e o caminho.`
            );
          }
          return `Falhou ao abrir "${achado.alias}" (alvo: ${target}). ${result.stderr}.`;
        }
        const nome = achado?.alias || app;
        const comArgumento = argument ? ` com ${argument}` : '';

        // `Start-Process` volta com sucesso assim que ENTREGA o pedido ao
        // Windows — o app pode subir e morrer logo depois, e a gente estaria
        // dizendo "abri" pra uma janela que sumiu. Confere antes de afirmar.
        await new Promise((r) => setTimeout(r, 2500));
        const processo = nomeDeProcesso(target);
        const vivo = await processoVivo(processo);
        if (!vivo) {
          // Nome de processo nem sempre bate com o alvo (o alias "vscode" vira
          // "Code"), entao isto e duvida, nao veredito.
          return (
            `Mandei abrir ${nome}, mas nao vejo processo "${processo}" rodando — ` +
            `pode ter fechado sozinho, ou so ter outro nome. Pergunte se abriu.`
          );
        }
        return `Abri ${nome}${comArgumento}.`;
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
