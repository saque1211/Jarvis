import { sendVirtualKey, VK, startProcess, ps } from '../platform/win32.js';
import { spotify, isConfigured } from '../integrations/spotify.js';

/**
 * Skill: reproduzir midia.
 *
 * Estrategia em camadas: se o Spotify estiver autorizado, usamos a Web API
 * (precisa e com metadados). Se nao, caimos nas teclas de midia do Windows,
 * que funcionam em qualquer player mas nao sabem o que esta tocando.
 */

async function withSpotify(action, fallback) {
  if (!isConfigured()) return fallback ? fallback() : 'Spotify nao autorizado. Rode: npm run auth:spotify';
  try {
    return await action();
  } catch (err) {
    return `Spotify: ${err.message}`;
  }
}

export default {
  name: 'media',
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
      speaks: true,
      description:
        'Busca no Spotify e toca o primeiro resultado. Use quando o usuario pedir uma musica, ' +
        'artista, album ou playlist pelo nome.',
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
        withSpotify(async () => {
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
        }),
    },
    {
      name: 'spotify_now_playing',
      speaks: true,
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
      description: 'Abre uma busca ou video do YouTube no navegador padrao.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Termo de busca ou URL completa do video.' },
        },
        required: ['query'],
      },
      handler: async ({ query }) => {
        const url = /^https?:\/\//.test(query)
          ? query
          : `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
        await startProcess(url);
        return `Abri o YouTube${/^https?:\/\//.test(query) ? '' : ` buscando ${query}`}.`;
      },
    },
  ],
};
