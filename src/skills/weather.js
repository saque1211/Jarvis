import { lerSettings, gravarSettings, dentroDaJanela } from '../core/settings.js';
import { writeRuntime } from '../core/state.js';

/**
 * Previsao do tempo pelo Open-Meteo.
 *
 * Escolhido por nao pedir chave de API: e a unica peca do sistema que funciona
 * no primeiro boot, sem cadastro, sem cartao e sem mais um segredo pra vazar
 * no `.env`. Tambem devolve probabilidade de chuva HORA A HORA, que e o que o
 * aviso de "leva guarda-chuva" precisa — previsao diaria nao serve pra isso.
 */

const API = 'https://api.open-meteo.com/v1/forecast';
const GEO = 'https://geocoding-api.open-meteo.com/v1/search';

// O HUD pergunta o tempo o tempo todo. Sem cache seria uma chamada por
// segundo pra um numero que muda de 15 em 15 minutos.
const VALIDADE_MS = 10 * 60 * 1000;
let cache = { em: 0, dados: null, chave: null };

/**
 * Codigo WMO → uma das condicoes que o HUD sabe desenhar.
 *
 * O Open-Meteo devolve 28 codigos distintos; o mockup tem quatro icones. Mapear
 * pra fora dessa lista deixaria o HUD sem icone justamente no dia estranho.
 */
export function condicaoDoCodigo(codigo) {
  const c = Number(codigo);
  if (c === 0) return 'Sol';
  if (c === 1 || c === 2) return 'Parcialmente nublado';
  if (c === 3 || c === 45 || c === 48) return 'Nublado';
  if ((c >= 51 && c <= 67) || (c >= 80 && c <= 82)) return 'Chuva';
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return 'Neve';
  if (c >= 95) return 'Tempestade';
  return 'Nublado';
}

/** Chuva de verdade pro aviso: garoa nao muda o plano de ninguem. */
export function ehChuva(condicao) {
  return condicao === 'Chuva' || condicao === 'Tempestade';
}

async function pedir(url, oQue) {
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(12000) });
  } catch (err) {
    const motivo = err.name === 'TimeoutError' ? 'demorou demais' : err.message;
    throw new Error(`Nao alcancei o servico de previsao (${motivo}).`);
  }
  if (!res.ok) throw new Error(`${oQue} respondeu ${res.status}.`);
  return res.json();
}

/** Nome de cidade → coordenadas. Guardado nas preferencias, roda uma vez so. */
export async function localizar(nome) {
  const url = `${GEO}?name=${encodeURIComponent(nome)}&count=1&language=pt&format=json`;
  const dados = await pedir(url, 'A busca de cidades');
  const achado = dados.results?.[0];
  if (!achado) throw new Error(`Nao achei a cidade "${nome}".`);
  return {
    nome: [achado.name, achado.admin1].filter(Boolean).join(', '),
    lat: achado.latitude,
    lon: achado.longitude,
  };
}

/**
 * O tempo agora e o que vem pela frente.
 *
 * Devolve null — e nao erro — quando falta o local. Sem cidade configurada, o
 * HUD tem que sumir com o bloco, nao piscar mensagem de erro a noite inteira.
 */
export async function previsao({ forcar = false } = {}) {
  const settings = lerSettings();
  const { lat, lon, nome } = settings.tempo.local;
  if (lat == null || lon == null) return null;

  const chave = `${lat},${lon}`;
  if (!forcar && cache.dados && cache.chave === chave && Date.now() - cache.em < VALIDADE_MS) {
    return cache.dados;
  }

  const url =
    `${API}?latitude=${lat}&longitude=${lon}` +
    '&current=temperature_2m,weather_code,is_day,apparent_temperature' +
    '&hourly=temperature_2m,weather_code,precipitation_probability' +
    '&daily=temperature_2m_max,temperature_2m_min' +
    '&forecast_days=2&timezone=auto';

  const dados = await pedir(url, 'O Open-Meteo');
  const agora = dados.current || {};
  const horas = dados.hourly || {};

  // O array horario comeca a meia-noite de hoje: as horas que ja passaram
  // continuam nele. Olhar pra frente sem cortar isso leria a chuva da manha
  // como se fosse a chuva de agora.
  const nesteMomento = new Date(agora.time || Date.now());
  const daquiPraFrente = (horas.time || [])
    .map((t, i) => ({
      quando: t,
      hora: new Date(t),
      temp: horas.temperature_2m?.[i],
      chance: horas.precipitation_probability?.[i] ?? 0,
      condicao: condicaoDoCodigo(horas.weather_code?.[i]),
    }))
    .filter((h) => h.hora >= nesteMomento);

  const janela = daquiPraFrente.slice(0, Math.max(1, settings.tempo.horasAFrente));
  const pico = janela.reduce((maior, h) => (h.chance > maior.chance ? h : maior), janela[0] || { chance: 0 });

  const resultado = {
    local: nome,
    temperatura: Math.round(agora.temperature_2m),
    sensacao: Math.round(agora.apparent_temperature ?? agora.temperature_2m),
    condicao: condicaoDoCodigo(agora.weather_code),
    dia: agora.is_day === 1,
    maxima: Math.round(dados.daily?.temperature_2m_max?.[0]),
    minima: Math.round(dados.daily?.temperature_2m_min?.[0]),
    chuva: {
      chance: pico.chance || 0,
      quando: pico.chance ? pico.quando : null,
      // O que dispara o aviso: a chance passou do que o usuario definiu.
      vaiChover: (pico.chance || 0) >= settings.tempo.chuvaMinima,
      horas: settings.tempo.horasAFrente,
    },
    proximas: janela.slice(0, 6).map((h) => ({
      hora: h.hora.getHours(),
      temp: Math.round(h.temp),
      chance: h.chance,
      condicao: h.condicao,
    })),
    lidoEm: new Date().toISOString(),
  };

  cache = { em: Date.now(), dados: resultado, chave };
  return resultado;
}

/**
 * O bloco de tempo deve estar na tela agora?
 *
 * Duas regras somadas: a janela que o usuario escolheu ("das 6 as 12") e a
 * excecao que ele pediu — se for chover, aparece fora de hora, porque previsao
 * so serve quando chega antes de voce sair de casa.
 */
export function deveMostrar(dados, quando = new Date(), settings = lerSettings()) {
  if (!settings.tempo.ativo || !dados) return false;
  if (dentroDaJanela(settings.tempo.mostrarDe, settings.tempo.mostrarAte, quando)) return true;
  return Boolean(settings.tempo.forcarSeChuva && dados.chuva?.vaiChover);
}

/** Uma frase falavel. O HUD desenha; a voz precisa disto. */
export function emPalavras(dados) {
  if (!dados) return 'Ainda nao sei onde voce esta. Me diga a cidade.';
  const partes = [`${dados.temperatura} graus, ${dados.condicao.toLowerCase()} em ${dados.local}`];
  if (dados.chuva.vaiChover) {
    partes.push(`com ${dados.chuva.chance} por cento de chance de chuva nas proximas ${dados.chuva.horas} horas`);
  }
  return `${partes.join(', ')}.`;
}

export default {
  name: 'weather',
  // Nao toca na maquina: vale no PC, no Raspberry e na nuvem.
  platform: '*',
  description: 'Previsao do tempo e chance de chuva.',
  tools: [
    {
      name: 'get_weather',
      speaks: true,
      description:
        'Diz o tempo agora e se vai chover. Use pra "como esta o tempo", "vai chover hoje", ' +
        '"preciso de guarda-chuva", "que temperatura esta la fora", "esta frio". ' +
        'Ja sabe a cidade configurada — nao peca a cidade ao usuario.',
      input_schema: { type: 'object', properties: {} },
      handler: async () => {
        try {
          const dados = await previsao();
          // Avisa o HUD que a previsao FOI PEDIDA agora, com os dados — o painel
          // desenha a cena animada do tempo por alguns segundos. So quando pedem;
          // fora disso o painel nao mostra essa cena.
          try {
            writeRuntime({
              climaPedido: {
                at: Date.now(),
                condicao: dados.condicao,
                temp: dados.temperatura,
                min: dados.minima,
                max: dados.maxima,
                dia: dados.dia,
                local: dados.local,
                vaiChover: dados.chuva?.vaiChover || false,
              },
            });
          } catch {
            /* sem HUD/vault ele ainda fala a previsao normalmente */
          }
          return emPalavras(dados);
        } catch (err) {
          return `Nao consegui a previsao: ${err.message}`;
        }
      },
    },
    {
      name: 'set_weather_location',
      speaks: true,
      description:
        'Define a cidade da previsao. Use quando o usuario disser onde mora ou pedir o tempo ' +
        'de outro lugar: "eu moro em Curitiba", "muda a previsao pra Sao Paulo".',
      input_schema: {
        type: 'object',
        properties: { city: { type: 'string', description: 'Nome da cidade. Ex: "Belo Horizonte".' } },
        required: ['city'],
      },
      handler: async ({ city }) => {
        try {
          const local = await localizar(city);
          gravarSettings({ tempo: { local } });
          cache = { em: 0, dados: null, chave: null };
          const agora = await previsao({ forcar: true });
          return `Previsao configurada pra ${local.nome}. ${emPalavras(agora)}`;
        } catch (err) {
          return err.message;
        }
      },
    },
  ],
};
