import { sendVirtualKey, VK, startProcess, ps } from '../platform/win32.js';
import { spotify, isConfigured } from '../integrations/spotify.js';

/**
 * Skill: reproduzir midia.
 *
 * Estrategia em camadas: se o Spotify estiver autorizado, usamos a Web API
 * (precisa e com metadados). Se nao, caimos nas teclas de midia do Windows,
 * que funcionam em qualquer player mas nao sabem o que esta tocando.
 */

/**
 * Descobre o primeiro resultado de uma busca no YouTube sem API nem chave: a
 * pagina de resultados traz os videoId embutidos no HTML.
 *
 * Nao lanca. E raspagem — o dia que o YouTube mudar o HTML, isto devolve null
 * e quem chama abre a busca, que e o comportamento de sempre.
 */
async function primeiroVideo(query) {
  try {
    const res = await fetch(
      `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
      {
        headers: {
          // Sem User-Agent de navegador o YouTube devolve uma pagina sem os IDs.
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'accept-language': 'pt-BR,pt;q=0.9',
        },
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!res.ok) return null;
    const html = await res.text();
    // 11 caracteres e o formato do ID; o primeiro que aparece e o primeiro
    // resultado da lista.
    return html.match(/"videoId":"([\w-]{11})"/)?.[1] || null;
  } catch {
    return null;
  }
}

async function withSpotify(action, fallback) {
  if (!isConfigured()) {
    if (fallback) return fallback();
    // Diz ao modelo o que fazer em vez de so reclamar: pedir musica pelo nome
    // funciona no YouTube sem configurar nada, e e isso que a pessoa quer.
    return (
      'Spotify nao autorizado. Use a tool play_youtube pra tocar isso agora, ' +
      'e avise que da pra ligar o Spotify com: npm run auth:spotify'
    );
  }
  try {
    return await action();
  } catch (err) {
    return `Spotify: ${err.message}`;
  }
}

export default {
  name: 'media',
  // Controla a maquina local: so faz sentido onde ela esta. O servidor na
  // nuvem carrega o registro sem estas, e o agente do PC carrega so estas.
  platform: 'win32',
  description: 'Controlar Spotify, YouTube, volume e teclas de midia.',
  tools: [
    {
      name: 'media_play_pause',
      speaks: true,
      description: 'Da play ou pausa no que estiver tocando. Funciona pra Spotify, YouTube, qualquer player.',
      input_schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['play', 'pause', 'toggle'], description: 'Padrao: toggle.' },
        },
      },
      handler: async ({ action = 'toggle' }) => {
        if (isConfigured() && action !== 'toggle') {
          return withSpotify(async () => {
            if (action === 'play') await spotify.play();
            else await spotify.pause();
            return action === 'play' ? 'Tocando.' : 'Pausei.';
          });
        }
        await sendVirtualKey(VK.MEDIA_PLAY_PAUSE);
        return 'Play/pause enviado.';
      },
    },
    {
      name: 'media_next',
      speaks: true,
      description: 'Pula pra proxima faixa.',
      input_schema: { type: 'object', properties: {} },
      handler: async () =>
        withSpotify(
          async () => {
            await spotify.next();
            return 'Proxima.';
          },
          async () => {
            await sendVirtualKey(VK.MEDIA_NEXT);
            return 'Proxima.';
          }
        ),
    },
    {
      name: 'media_previous',
      speaks: true,
      description: 'Volta pra faixa anterior.',
      input_schema: { type: 'object', properties: {} },
      handler: async () =>
        withSpotify(
          async () => {
            await spotify.previous();
            return 'Anterior.';
          },
          async () => {
            await sendVirtualKey(VK.MEDIA_PREV);
            return 'Anterior.';
          }
        ),
    },
    {
      name: 'set_volume',
      speaks: true,
      description:
        'Ajusta o volume. Use "level" (0-100) pro volume do sistema, ou direction=up/down pra ajuste relativo.',
      input_schema: {
        type: 'object',
        properties: {
          level: { type: 'number', description: 'Volume absoluto 0-100.' },
          direction: { type: 'string', enum: ['up', 'down', 'mute'] },
          steps: { type: 'number', description: 'Quantos degraus (2% cada). Padrao 4.' },
        },
      },
      handler: async ({ level, direction, steps = 4 }) => {
        if (typeof level === 'number') {
          const clamped = Math.max(0, Math.min(100, Math.round(level)));
          // Volume do sistema via COM do Windows Shell.
          const script = `
$obj = New-Object -ComObject WScript.Shell
# Zera e sobe em degraus de 2% ate o alvo — a API COM nao aceita valor absoluto.
for ($i = 0; $i -lt 50; $i++) { $obj.SendKeys([char]174) }
for ($i = 0; $i -lt ${Math.round(clamped / 2)}; $i++) { $obj.SendKeys([char]175) }
`;
          await ps(script);
          if (isConfigured()) {
            try {
              await spotify.setVolume(clamped);
            } catch {
              // Sem dispositivo ativo no Spotify: o volume do sistema ja resolveu.
            }
          }
          return `Volume em ${clamped}%.`;
        }

        if (direction === 'mute') {
          await sendVirtualKey(VK.VOLUME_MUTE);
          return 'Mutado.';
        }
        await sendVirtualKey(direction === 'up' ? VK.VOLUME_UP : VK.VOLUME_DOWN, steps);
        return `Volume ${direction === 'up' ? 'aumentado' : 'diminuido'}.`;
      },
    },
    {
      name: 'spotify_play_search',
      // Os dois caminhos terminam em frase falavel — tocando de verdade, ou
      // "abri no Spotify, e so dar play". Nenhum precisa de outra ida ao
      // modelo pra virar resposta.
      speaks: true,
      description:
        'Toca uma musica, artista, album ou playlist NO SPOTIFY pelo nome. ' +
        'E a tool preferida pra "toca <musica>", "poe <artista>" — o usuario ' +
        'quer o Spotify. So use play_youtube se ele pedir YouTube, ou se esta ' +
        'aqui falhar.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'O que buscar. Ex: "bohemian rhapsody", "lo-fi beats".' },
          type: {
            type: 'string',
            enum: ['track', 'album', 'artist', 'playlist'],
            description: 'Tipo. Padrao track.',
          },
        },
        required: ['query'],
      },
      handler: async ({ query, type = 'track' }) =>
        withSpotify(
          async () => {
            const results = await spotify.search(query, type, 1);
            const items = results?.[`${type}s`]?.items;
            if (!items?.length) return `Nao achei "${query}" no Spotify.`;

            const item = items[0];
            if (type === 'track') {
              await spotify.play([item.uri]);
              return `Tocando ${item.name}, de ${item.artists.map((a) => a.name).join(', ')}.`;
            }
            await spotify.playContext(item.uri);
            return `Tocando ${type === 'artist' ? '' : 'o '}${item.name}.`;
          },
          // Sem autorizacao nao da pra BUSCAR (a API do Spotify exige token),
          // mas da pra abrir o app ja com a busca feita: fica faltando so o
          // play. E melhor que jogar pro YouTube, que e outro tocador.
          async () => {
            const r = await startProcess(`spotify:search:${encodeURIComponent(query)}`);
            if (!r.ok) {
              return (
                `Nao consegui abrir o Spotify. Pra ele tocar sozinho, rode ` +
                `npm run auth:spotify no terminal.`
              );
            }
            return `Abri ${query} no Spotify. E so dar play.`;
          }
        ),
    },
    {
      name: 'spotify_now_playing',
      // Funcao, nao `true`: com o Spotify autorizado a saida ja e a frase
      // final. Sem autorizacao ela e um recado PRO MODELO ("use o
      // play_youtube"), e ai o router precisa fazer a viagem de volta em vez
      // de mandar esse texto direto pro alto-falante.
      speaks: () => isConfigured(),
      description: 'Diz o que esta tocando agora no Spotify.',
      input_schema: { type: 'object', properties: {} },
      handler: async () =>
        withSpotify(async () => {
          const data = await spotify.current();
          if (!data?.item) return 'Nada tocando no Spotify agora.';
          const artists = data.item.artists?.map((a) => a.name).join(', ');
          return `${data.item.name}${artists ? `, de ${artists}` : ''}. ${data.is_playing ? 'Tocando' : 'Pausado'}.`;
        }),
    },
    {
      name: 'spotify_devices',
      description: 'Lista os dispositivos do Spotify e permite transferir a reproducao pra um deles.',
      input_schema: {
        type: 'object',
        properties: {
          transfer_to: { type: 'string', description: 'Nome do dispositivo pra assumir a reproducao.' },
        },
      },
      handler: async ({ transfer_to }) =>
        withSpotify(async () => {
          const data = await spotify.devices();
          const devices = data?.devices || [];
          if (!devices.length) return 'Nenhum dispositivo Spotify visivel. Abra o app.';

          if (transfer_to) {
            const match = devices.find((d) =>
              d.name.toLowerCase().includes(transfer_to.toLowerCase())
            );
            if (!match) return `Nao achei "${transfer_to}". Disponiveis: ${devices.map((d) => d.name).join(', ')}.`;
            await spotify.transfer(match.id);
            return `Passei a reproducao pro ${match.name}.`;
          }

          return devices.map((d) => `${d.name}${d.is_active ? ' (ativo)' : ''}`).join(', ');
        }),
    },
    {
      name: 'play_youtube',
      speaks: true,
      description:
        'Toca uma musica ou video NO YOUTUBE, no navegador. Use quando o ' +
        'usuario pedir YouTube por nome, quando quiser assistir um video, ou ' +
        'se a tool do Spotify falhar. Pra pedido de musica sem provedor dito, ' +
        'prefira spotify_play_search. Aceita tambem uma URL de video.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Termo de busca ou URL completa do video.' },
        },
        required: ['query'],
      },
      handler: async ({ query }) => {
        // Erro do Start-Process era descartado: quando o navegador nao abria,
        // a frase dizia "abri" do mesmo jeito e a pessoa ficava procurando uma
        // janela que nunca existiu.
        const abrir = async (url, frase) => {
          const r = await startProcess(url);
          if (!r.ok) {
            return `Nao consegui abrir o navegador. ${r.stderr || ''}`.trim();
          }
          return frase;
        };

        if (/^https?:\/\//.test(query)) return abrir(query, 'Abri o video.');

        const video = await primeiroVideo(query);
        if (video) {
          // autoplay=1 pede pro YouTube comecar sozinho. O navegador pode
          // recusar (politica de reproducao automatica), por isso a frase
          // abaixo diz "abri", nao "tocando" — prometer play e mentir quando
          // depende de uma decisao do Chrome que a gente nao controla.
          return abrir(
            `https://www.youtube.com/watch?v=${video}&autoplay=1`,
            `Abri ${query} no YouTube. Se nao comecar sozinho, e so dar play.`
          );
        }

        // Nao deu pra descobrir o primeiro resultado: abre a busca, que e o
        // comportamento antigo. Pior caso e igual ao que ja existia.
        return abrir(
          `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
          `Abri o YouTube buscando ${query} — escolhe o video que quiser.`
        );
      },
    },
  ],
};
