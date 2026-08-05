import fs from 'node:fs';
import path from 'node:path';
import { config, ensureDirs } from '../core/config.js';
import { appendDaily } from '../core/vault.js';

/**
 * Skill: freelance.
 *
 * Aviso honesto: Workana e Fiverr NAO tem API publica de freelancer. O que
 * existe e feed RSS de vagas (Workana publica por categoria) e a pagina
 * autenticada. Entao esta skill trabalha com feeds que voce cadastrar e
 * guarda o que ja viu, pra so avisar do que e novo. Status de job em
 * andamento continua sendo coisa de abrir o site.
 */

function seenFile() {
  ensureDirs();
  return path.join(config.vaultPath, 'tasks', 'freelance-seen.json');
}

function loadSeen() {
  const file = seenFile();
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function saveSeen(seen) {
  fs.writeFileSync(seenFile(), JSON.stringify(seen, null, 2), 'utf8');
}

function decode(text) {
  return String(text || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Parser de RSS/Atom sem dependencia — cobre os dois formatos usuais. */
function parseFeed(xml) {
  const items = [];
  const blocks = xml.match(/<(item|entry)[\s\S]*?<\/\1>/g) || [];

  for (const block of blocks) {
    const title = decode(block.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1]);
    const link =
      block.match(/<link[^>]*href=["']([^"']+)["']/)?.[1] ||
      decode(block.match(/<link[^>]*>([\s\S]*?)<\/link>/)?.[1]);
    const description = decode(
      block.match(/<(?:description|summary|content)[^>]*>([\s\S]*?)<\/(?:description|summary|content)>/)?.[1]
    );
    const date = decode(
      block.match(/<(?:pubDate|published|updated)[^>]*>([\s\S]*?)<\/(?:pubDate|published|updated)>/)?.[1]
    );
    const id = decode(block.match(/<(?:guid|id)[^>]*>([\s\S]*?)<\/(?:guid|id)>/)?.[1]) || link;

    if (title) items.push({ id, title, link, description: description.slice(0, 300), date });
  }
  return items;
}

async function fetchFeed(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'JARVIS/0.2 (assistente pessoal)',
      Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml',
      ...(config.freelance.workanaCookie && url.includes('workana')
        ? { Cookie: config.freelance.workanaCookie }
        : {}),
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseFeed(await res.text());
}

export default {
  name: 'freelance',
  description: 'Monitorar vagas de freelance em feeds do Workana, Fiverr e afins.',
  tools: [
    {
      name: 'check_freelance_jobs',
      description:
        'Checa os feeds de freelance cadastrados e mostra as vagas NOVAS desde a ultima checagem. ' +
        'Configure os feeds em FREELANCE_FEEDS no .env (separados por virgula).',
      input_schema: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: 'Filtra as vagas por palavra-chave.' },
          include_seen: { type: 'boolean', description: 'Mostra tambem as que ja tinham aparecido.' },
        },
      },
      handler: async ({ keyword, include_seen }) => {
        const feeds = config.freelance.feeds;
        if (!feeds.length) {
          return (
            'Nenhum feed cadastrado. Coloque FREELANCE_FEEDS no .env — ' +
            'ex: https://www.workana.com/jobs/rss?category=it-programming&language=pt. ' +
            'Veja .skills/freelance.md pra montar a URL certa.'
          );
        }

        const seen = loadSeen();
        const fresh = [];
        const errors = [];

        for (const feed of feeds) {
          try {
            const items = await fetchFeed(feed);
            for (const item of items) {
              const isNew = !seen[item.id];
              seen[item.id] = Date.now();
              if (isNew || include_seen) fresh.push(item);
            }
          } catch (err) {
            errors.push(`${feed}: ${err.message}`);
          }
        }

        // Poda entradas com mais de 30 dias pra o arquivo nao inchar.
        const cutoff = Date.now() - 30 * 86400000;
        for (const [id, ts] of Object.entries(seen)) if (ts < cutoff) delete seen[id];
        saveSeen(seen);

        let results = fresh;
        if (keyword) {
          const q = keyword.toLowerCase();
          results = results.filter(
            (i) => i.title.toLowerCase().includes(q) || i.description.toLowerCase().includes(q)
          );
        }

        const errorNote = errors.length ? `\n\nFeeds com erro:\n${errors.join('\n')}` : '';
        if (!results.length) return `Nenhuma vaga nova${keyword ? ` com "${keyword}"` : ''}.${errorNote}`;

        appendDaily('Freelance', `${results.length} vaga(s) nova(s) encontrada(s)`);
        return (
          results
            .slice(0, 10)
            .map((i) => `${i.title}\n${i.description.slice(0, 160)}\n${i.link}`)
            .join('\n\n') + errorNote
        );
      },
    },
    {
      name: 'add_freelance_feed',
      description:
        'Adiciona um feed de vagas ao .env em tempo de execucao (vale ate reiniciar). ' +
        'Pra ficar permanente, o usuario precisa editar FREELANCE_FEEDS no .env.',
      input_schema: {
        type: 'object',
        properties: { url: { type: 'string', description: 'URL do feed RSS/Atom.' } },
        required: ['url'],
      },
      handler: async ({ url }) => {
        if (config.freelance.feeds.includes(url)) return 'Esse feed ja esta na lista.';
        config.freelance.feeds.push(url);
        return (
          `Adicionei o feed nesta sessao. Pra manter depois de reiniciar, ponha no .env:\n` +
          `FREELANCE_FEEDS=${config.freelance.feeds.join(',')}`
        );
      },
    },
    {
      name: 'list_freelance_feeds',
      description: 'Mostra quais feeds de freelance estao sendo monitorados.',
      input_schema: { type: 'object', properties: {} },
      handler: async () => {
        const feeds = config.freelance.feeds;
        if (!feeds.length) return 'Nenhum feed cadastrado.';
        return feeds.join('\n');
      },
    },
  ],
};
