import { config } from '../core/config.js';

/**
 * Skill: buscar e pesquisar.
 *
 * Web search usa a Brave Search API quando ha chave; sem chave, cai no
 * endpoint publico do DuckDuckGo (so responde bem a perguntas factuais, mas
 * nao exige cadastro). GitHub e Stack Overflow tem APIs publicas decentes.
 */

async function braveSearch(query, count) {
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(count));

  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': config.brave.apiKey },
  });
  if (!res.ok) throw new Error(`Brave ${res.status}`);

  const data = await res.json();
  const results = data.web?.results || [];
  if (!results.length) return null;
  return results
    .map((r) => `${r.title}\n${r.url}\n${r.description?.replace(/<[^>]+>/g, '') || ''}`)
    .join('\n\n');
}

async function duckduckgoSearch(query) {
  const url = new URL('https://api.duckduckgo.com/');
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('no_html', '1');

  const res = await fetch(url);
  if (!res.ok) throw new Error(`DuckDuckGo ${res.status}`);
  const data = await res.json();

  const parts = [];
  if (data.AbstractText) parts.push(`${data.AbstractText}\n${data.AbstractURL || ''}`);
  for (const topic of (data.RelatedTopics || []).slice(0, 5)) {
    if (topic.Text) parts.push(`${topic.Text}\n${topic.FirstURL || ''}`);
  }
  return parts.length ? parts.join('\n\n') : null;
}

export default {
  name: 'search',
  description: 'Pesquisar na web, no GitHub, no Stack Overflow e em documentacao.',
  tools: [
    {
      name: 'web_search',
      description:
        'Pesquisa na web e me devolve o conteudo pra eu responder ao usuario. ' +
        'Use quando ele quer uma RESPOSTA. Se ele quer ver a pagina, use browser_search.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          count: { type: 'number', description: 'Quantos resultados. Padrao 5.' },
        },
        required: ['query'],
      },
      handler: async ({ query, count = 5 }) => {
        try {
          if (config.brave.apiKey) {
            const result = await braveSearch(query, count);
            if (result) return result;
          }
          const fallback = await duckduckgoSearch(query);
          if (fallback) return fallback;
          return config.brave.apiKey
            ? `Sem resultados pra "${query}".`
            : `Sem resultado util. Configure BRAVE_API_KEY no .env pra busca web completa ` +
                `(gratis ate 2000 consultas/mes em brave.com/search/api).`;
        } catch (err) {
          return `Busca falhou: ${err.message}`;
        }
      },
    },
    {
      name: 'github_search',
      description:
        'Pesquisa no GitHub por repositorios, codigo ou issues. Codigo exige GITHUB_TOKEN configurado.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          type: { type: 'string', enum: ['repositories', 'code', 'issues'], description: 'Padrao: repositories.' },
        },
        required: ['query'],
      },
      handler: async ({ query, type = 'repositories' }) => {
        if (type === 'code' && !config.github.token) {
          return 'Busca de codigo no GitHub exige GITHUB_TOKEN no .env.';
        }
        const url = new URL(`https://api.github.com/search/${type}`);
        url.searchParams.set('q', query);
        url.searchParams.set('per_page', '5');

        const headers = { Accept: 'application/vnd.github+json' };
        if (config.github.token) headers.Authorization = `Bearer ${config.github.token}`;

        const res = await fetch(url, { headers });
        if (!res.ok) return `GitHub ${res.status}: ${(await res.text()).slice(0, 200)}`;

        const data = await res.json();
        if (!data.items?.length) return `Nada encontrado no GitHub pra "${query}".`;

        return data.items
          .slice(0, 5)
          .map((item) => {
            if (type === 'repositories') {
              return `${item.full_name} (${item.stargazers_count} estrelas)\n${item.description || ''}\n${item.html_url}`;
            }
            if (type === 'code') return `${item.repository.full_name} — ${item.path}\n${item.html_url}`;
            return `#${item.number} ${item.title} [${item.state}]\n${item.html_url}`;
          })
          .join('\n\n');
      },
    },
    {
      name: 'stackoverflow_search',
      description: 'Busca perguntas respondidas no Stack Overflow. Bom pra erro especifico de codigo.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'A mensagem de erro ou a duvida.' },
          tag: { type: 'string', description: 'Tag pra filtrar. Ex: "javascript", "python".' },
        },
        required: ['query'],
      },
      handler: async ({ query, tag }) => {
        const url = new URL('https://api.stackexchange.com/2.3/search/advanced');
        url.searchParams.set('order', 'desc');
        url.searchParams.set('sort', 'relevance');
        url.searchParams.set('q', query);
        url.searchParams.set('site', 'stackoverflow');
        url.searchParams.set('accepted', 'True');
        url.searchParams.set('filter', '!nNPvSNdWme');
        if (tag) url.searchParams.set('tagged', tag);

        const res = await fetch(url);
        if (!res.ok) return `Stack Overflow ${res.status}`;

        const data = await res.json();
        if (!data.items?.length) return `Nenhuma pergunta respondida sobre "${query}".`;

        return data.items
          .slice(0, 5)
          .map((q) => `${q.title} (${q.score} votos)\n${q.link}`)
          .join('\n\n');
      },
    },
    {
      name: 'npm_search',
      description: 'Busca pacotes no npm com descricao, versao e link.',
      input_schema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
      handler: async ({ query }) => {
        const res = await fetch(
          `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=5`
        );
        if (!res.ok) return `npm ${res.status}`;

        const data = await res.json();
        if (!data.objects?.length) return `Nenhum pacote pra "${query}".`;

        return data.objects
          .map(({ package: p }) => `${p.name}@${p.version}\n${p.description || ''}\n${p.links.npm}`)
          .join('\n\n');
      },
    },
    {
      name: 'fetch_page',
      description:
        'Baixa uma pagina e devolve o texto dela, pra eu ler documentacao ou um artigo especifico.',
      input_schema: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      },
      handler: async ({ url }) => {
        const target = /^https?:\/\//i.test(url) ? url : `https://${url}`;
        const res = await fetch(target, {
          headers: { 'User-Agent': 'JARVIS/0.2 (assistente pessoal)' },
        });
        if (!res.ok) return `Nao consegui baixar: HTTP ${res.status}`;

        const html = await res.text();
        // Extracao ingenua, mas suficiente pra ler docs sem puxar um parser inteiro.
        const text = html
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/\s+/g, ' ')
          .trim();
        return text.slice(0, 6000) || 'Pagina sem texto extraivel.';
      },
    },
  ],
};
