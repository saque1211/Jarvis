import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startProcess, ps, killProcess } from '../platform/win32.js';
import { config, loadJson, saveJson } from '../core/config.js';

/**
 * Skill: navegador.
 *
 * O que da pra fazer de fora do navegador com confiabilidade: abrir URLs,
 * abrir conjuntos de abas ("workspaces") e ler os bookmarks — que o Chrome e
 * o Edge guardam num JSON em disco. Manipular abas ja abertas exigiria uma
 * extensao; por isso workspaces existem: em vez de reorganizar o caos, voce
 * abre a janela certa de uma vez.
 */

const BOOKMARK_PATHS = {
  chrome: path.join(os.homedir(), 'AppData/Local/Google/Chrome/User Data/Default/Bookmarks'),
  edge: path.join(os.homedir(), 'AppData/Local/Microsoft/Edge/User Data/Default/Bookmarks'),
  brave: path.join(
    os.homedir(),
    'AppData/Local/BraveSoftware/Brave-Browser/User Data/Default/Bookmarks'
  ),
};

const BROWSER_EXE = {
  chrome: 'chrome',
  edge: 'msedge',
  brave: 'brave',
  firefox: 'firefox',
};

function workspacesFile() {
  return path.join(config.root, 'config', 'tab-workspaces.json');
}

function flattenBookmarks(node, folder = '', out = []) {
  if (!node) return out;
  if (node.type === 'url') {
    out.push({ name: node.name, url: node.url, folder });
  }
  for (const child of node.children || []) {
    flattenBookmarks(child, node.name ? `${folder}/${node.name}`.replace(/^\//, '') : folder, out);
  }
  return out;
}

function readBookmarks(browser) {
  const file = BOOKMARK_PATHS[browser];
  if (!file || !fs.existsSync(file)) return null;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const out = [];
  for (const root of Object.values(data.roots || {})) {
    if (typeof root === 'object') flattenBookmarks(root, '', out);
  }
  return out;
}

export default {
  name: 'browser',
  // Controla a maquina local: so faz sentido onde ela esta. O servidor na
  // nuvem carrega o registro sem estas, e o agente do PC carrega so estas.
  platform: 'win32',
  description: 'Abrir links, conjuntos de abas e consultar bookmarks.',
  tools: [
    {
      name: 'open_url',
      description: 'Abre uma ou mais URLs no navegador. Se nao passar browser, usa o padrao do sistema.',
      input_schema: {
        type: 'object',
        properties: {
          urls: {
            type: 'array',
            items: { type: 'string' },
            description: 'URLs. Aceita sem https:// — eu completo.',
          },
          browser: { type: 'string', enum: ['chrome', 'edge', 'brave', 'firefox', 'default'] },
          new_window: { type: 'boolean', description: 'Abre numa janela nova em vez de aba.' },
        },
        required: ['urls'],
      },
      handler: async ({ urls, browser = 'default', new_window }) => {
        const normalized = urls.map((u) => (/^[a-z]+:\/\//i.test(u) ? u : `https://${u}`));

        if (browser === 'default') {
          for (const url of normalized) await startProcess(url);
        } else {
          const exe = BROWSER_EXE[browser];
          const args = new_window ? ['--new-window', ...normalized] : normalized;
          const result = await startProcess(exe, args);
          if (!result.ok) return `Nao consegui abrir o ${browser}: ${result.stderr}`;
        }
        return normalized.length === 1
          ? `Abri ${normalized[0]}.`
          : `Abri ${normalized.length} abas.`;
      },
    },
    {
      name: 'open_tab_workspace',
      description:
        'Abre um conjunto de abas salvo (workspace). Ex: "trabalho" abre GitHub, Linear e docs de uma vez. ' +
        'Sem nome, lista os workspaces disponiveis.',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Nome do workspace.' },
        },
      },
      handler: async ({ name }) => {
        const workspaces = loadJson(workspacesFile(), {});
        if (!name) {
          const keys = Object.keys(workspaces);
          return keys.length ? `Workspaces: ${keys.join(', ')}.` : 'Nenhum workspace salvo ainda.';
        }
        const ws = workspaces[name.toLowerCase().trim()];
        if (!ws) {
          return `Nao conheco o workspace "${name}". Disponiveis: ${Object.keys(workspaces).join(', ') || 'nenhum'}.`;
        }
        const exe = BROWSER_EXE[ws.browser] || 'chrome';
        await startProcess(exe, ['--new-window', ...ws.urls]);
        return `Abri o workspace ${name} com ${ws.urls.length} abas.`;
      },
    },
    {
      name: 'save_tab_workspace',
      description: 'Salva um conjunto de URLs como workspace nomeado pra abrir depois por voz.',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          urls: { type: 'array', items: { type: 'string' } },
          browser: { type: 'string', enum: ['chrome', 'edge', 'brave', 'firefox'] },
        },
        required: ['name', 'urls'],
      },
      handler: async ({ name, urls, browser = 'chrome' }) => {
        const file = workspacesFile();
        const workspaces = loadJson(file, {});
        workspaces[name.toLowerCase().trim()] = {
          browser,
          urls: urls.map((u) => (/^[a-z]+:\/\//i.test(u) ? u : `https://${u}`)),
        };
        saveJson(file, workspaces);
        return `Salvei o workspace "${name}" com ${urls.length} abas.`;
      },
    },
    {
      name: 'search_bookmarks',
      description: 'Busca nos bookmarks do Chrome/Edge/Brave por nome ou URL. Pode abrir o resultado direto.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          browser: { type: 'string', enum: ['chrome', 'edge', 'brave'], description: 'Padrao: chrome.' },
          open_first: { type: 'boolean', description: 'Abre o primeiro resultado automaticamente.' },
        },
        required: ['query'],
      },
      handler: async ({ query, browser = 'chrome', open_first }) => {
        const bookmarks = readBookmarks(browser);
        if (!bookmarks) return `Nao achei os bookmarks do ${browser}. O perfil padrao existe?`;

        const q = query.toLowerCase();
        const hits = bookmarks.filter(
          (b) => b.name?.toLowerCase().includes(q) || b.url?.toLowerCase().includes(q)
        );
        if (!hits.length) return `Nenhum bookmark com "${query}".`;

        if (open_first) {
          await startProcess(hits[0].url);
          return `Abri ${hits[0].name}.`;
        }
        return hits
          .slice(0, 10)
          .map((b) => `${b.name} — ${b.url}`)
          .join('\n');
      },
    },
    {
      name: 'browser_search',
      description: 'Faz uma busca web abrindo o navegador. Use quando o usuario quer VER os resultados, ' +
        'nao quando quer que EU pesquise e responda (nesse caso use web_search).',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          engine: { type: 'string', enum: ['google', 'duckduckgo', 'youtube', 'github'] },
        },
        required: ['query'],
      },
      handler: async ({ query, engine = 'google' }) => {
        const engines = {
          google: 'https://www.google.com/search?q=',
          duckduckgo: 'https://duckduckgo.com/?q=',
          youtube: 'https://www.youtube.com/results?search_query=',
          github: 'https://github.com/search?q=',
        };
        await startProcess(engines[engine] + encodeURIComponent(query));
        return `Buscando "${query}" no ${engine}.`;
      },
    },
    {
      name: 'close_browser',
      description: 'Fecha o navegador inteiro. DESTRUTIVO (perde abas) — confirme antes.',
      input_schema: {
        type: 'object',
        properties: {
          browser: { type: 'string', enum: ['chrome', 'edge', 'brave', 'firefox'] },
          confirmed: { type: 'boolean' },
        },
        required: ['browser'],
      },
      handler: async ({ browser, confirmed }) => {
        if (!confirmed) return 'Nao fechei. Confirme com o usuario — ele vai perder as abas abertas.';
        const names = { chrome: 'chrome', edge: 'msedge', brave: 'brave', firefox: 'firefox' };
        const result = await killProcess(names[browser]);
        return result.ok ? `Fechei o ${browser}.` : `O ${browser} nao estava aberto.`;
      },
    },
  ],
};
