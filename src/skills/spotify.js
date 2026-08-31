import { spotify, isConfigured } from '../integrations/spotify.js';

/**
 * Skill: musica no Spotify.
 *
 * Fica separada da skill `media` (que e win32: teclas de midia, YouTube) porque
 * a Web API do Spotify e so HTTP + token — roda igual na nuvem, que e onde o
 * cerebro do Vexis vive. Por isso `platform: '*'`.
 *
 * Precisa de: um app no Spotify (SPOTIFY_CLIENT_ID/SECRET no .env), a
 * autorizacao uma vez (`npm run auth:spotify`), e uma conta Premium — a Spotify
 * so deixa controlar reproducao no Premium. O "onde toca" e qualquer aparelho
 * com o app aberto (Spotify Connect): celular, PC, caixa.
 */

async function comSpotify(acao) {
  if (!isConfigured()) {
    return (
      'O Spotify ainda nao esta conectado. Peca pra configurar: criar o app no ' +
      'developer.spotify.com, por a chave no .env e rodar npm run auth:spotify.'
    );
  }
  try {
    return await acao();
  } catch (err) {
    return `Spotify: ${err.message}`;
  }
}

export default {
  name: 'spotify',
  platform: '*',
  description: 'Tocar e controlar musica no Spotify: buscar e tocar, pausar, pular, volume e dispositivos.',
  tools: [
    {
      name: 'spotify_play_search',
      speaks: true,
      description:
        'Toca uma musica, artista, album ou playlist NO SPOTIFY pelo nome. E a ' +
        'tool preferida pra "toca <musica>", "poe <artista>", "coloca uma ' +
        'playlist de <coisa>". O usuario quer o Spotify.',
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
        comSpotify(async () => {
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
      name: 'spotify_control',
      speaks: true,
      description:
        'Controla o que ja esta tocando no Spotify: pausar, retomar, proxima, ' +
        'anterior, embaralhar. Use pra "pausa", "continua", "proxima musica", ' +
        '"pula essa", "volta", "modo aleatorio".',
      input_schema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['pause', 'resume', 'next', 'previous', 'shuffle_on', 'shuffle_off'],
          },
        },
        required: ['action'],
      },
      handler: async ({ action }) =>
        comSpotify(async () => {
          switch (action) {
            case 'pause': await spotify.pause(); return 'Pausei.';
            case 'resume': await spotify.play(); return 'Voltando.';
            case 'next': await spotify.next(); return 'Proxima.';
            case 'previous': await spotify.previous(); return 'Anterior.';
            case 'shuffle_on': await spotify.shuffle(true); return 'Modo aleatorio ligado.';
            case 'shuffle_off': await spotify.shuffle(false); return 'Modo aleatorio desligado.';
            default: return 'Nao entendi o comando.';
          }
        }),
    },
    {
      name: 'spotify_volume',
      speaks: true,
      description: 'Ajusta o volume do Spotify (0 a 100). Use pra "volume no Spotify", "aumenta a musica".',
      input_schema: {
        type: 'object',
        properties: {
          percent: { type: 'number', description: 'Volume de 0 a 100.' },
        },
        required: ['percent'],
      },
      handler: async ({ percent }) =>
        comSpotify(async () => {
          const p = Math.max(0, Math.min(100, Math.round(percent)));
          await spotify.setVolume(p);
          return `Volume do Spotify em ${p} por cento.`;
        }),
    },
    {
      name: 'spotify_now_playing',
      // Com o Spotify conectado a saida ja e a frase final. Sem, e um recado pro
      // modelo, entao o router precisa da viagem de volta.
      speaks: () => isConfigured(),
      description: 'Diz o que esta tocando agora no Spotify.',
      input_schema: { type: 'object', properties: {} },
      handler: async () =>
        comSpotify(async () => {
          const data = await spotify.current();
          if (!data?.item) return 'Nada tocando no Spotify agora.';
          const artists = data.item.artists?.map((a) => a.name).join(', ');
          return `${data.item.name}${artists ? `, de ${artists}` : ''}. ${data.is_playing ? 'Tocando' : 'Pausado'}.`;
        }),
    },
    {
      name: 'spotify_devices',
      description: 'Lista os aparelhos do Spotify (celular, PC, caixa) e passa a reproducao pra um deles.',
      input_schema: {
        type: 'object',
        properties: {
          transfer_to: { type: 'string', description: 'Nome do aparelho pra assumir a reproducao.' },
        },
      },
      handler: async ({ transfer_to }) =>
        comSpotify(async () => {
          const data = await spotify.devices();
          const devices = data?.devices || [];
          if (!devices.length) return 'Nenhum aparelho Spotify visivel. Abra o app do Spotify em algum lugar.';
          if (transfer_to) {
            const match = devices.find((d) => d.name.toLowerCase().includes(transfer_to.toLowerCase()));
            if (!match) return `Nao achei "${transfer_to}". Disponiveis: ${devices.map((d) => d.name).join(', ')}.`;
            await spotify.transfer(match.id);
            return `Passei a reproducao pro ${match.name}.`;
          }
          return devices.map((d) => `${d.name}${d.is_active ? ' (ativo)' : ''}`).join(', ');
        }),
    },
  ],
};
