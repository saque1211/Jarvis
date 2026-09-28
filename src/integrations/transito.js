/**
 * Transito ao vivo pela TomTom.
 *
 * Por que TomTom e nao Google Maps: o Directions do Google exige projeto com
 * cartao de credito cadastrado antes da primeira chamada. A TomTom da 2.500
 * requisicoes por dia com so um e-mail, cobre o Brasil e devolve exatamente o
 * numero que interessa — quanto tempo a mais o transito esta custando AGORA em
 * relacao a via livre. Waze nao tem API publica; o app e o produto.
 *
 * Duas rotas da API sao usadas:
 *   - search/2/search  → endereco ou nome de lugar falado vira coordenada
 *   - routing/1/calculateRoute → tempo com transito, sem transito e o atraso
 */

const BUSCA = 'https://api.tomtom.com/search/2/search';
const ROTA = 'https://api.tomtom.com/routing/1/calculateRoute';

const PRAZO_MS = Number(process.env.TOMTOM_TIMEOUT_MS || 10000);
const PAIS = process.env.TOMTOM_PAIS || 'BR';

// Transito muda em minutos, nao em segundos. Sem cache, repetir a pergunta
// ("e agora?") gastaria uma chamada da cota por vez sem trazer numero novo.
const VALIDADE_MS = 2 * 60 * 1000;
const cache = new Map();

export function chave() {
  return (process.env.TOMTOM_API_KEY || '').trim() || null;
}

export function configurado() {
  return Boolean(chave());
}

async function pedir(url, oQue) {
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(PRAZO_MS) });
  } catch (err) {
    const motivo = err.name === 'TimeoutError' ? 'demorou demais' : err.message;
    throw new Error(`Nao alcancei o servico de transito (${motivo}).`);
  }
  if (res.status === 403) {
    throw new Error('A chave do TomTom foi recusada. Confira TOMTOM_API_KEY no .env.');
  }
  if (res.status === 429) {
    throw new Error('A cota diaria do TomTom acabou. Volta a contar amanha.');
  }
  if (!res.ok) throw new Error(`${oQue} respondeu ${res.status}.`);
  return res.json();
}

/**
 * Endereco ou nome falado → coordenada.
 *
 * Usa a busca difusa (e nao o geocode puro) de proposito: a entrada vem de
 * transcricao de voz, onde "shopping do centro" e tao comum quanto
 * "rua tal, 120". A difusa aceita os dois; o geocode so o segundo.
 *
 * Quando ja existe uma origem, ela entra como vies de proximidade — sem isso
 * "Avenida Brasil" pode cair em outro estado.
 */
export async function localizar(consulta, perto = null) {
  if (!configurado()) throw new Error('Falta a chave do TomTom (TOMTOM_API_KEY no .env).');
  const texto = String(consulta || '').trim();
  if (!texto) throw new Error('Preciso do endereco ou do nome do lugar.');

  let url =
    `${BUSCA}/${encodeURIComponent(texto)}.json` +
    `?key=${encodeURIComponent(chave())}&limit=1&language=pt-BR&countrySet=${encodeURIComponent(PAIS)}`;
  if (perto && perto.lat != null && perto.lon != null) {
    url += `&lat=${perto.lat}&lon=${perto.lon}&radius=60000`;
  }

  const dados = await pedir(url, 'A busca de enderecos');
  const achado = dados.results?.[0];
  if (!achado?.position) throw new Error(`Nao achei "${texto}" no mapa.`);

  const endereco = achado.address?.freeformAddress || texto;
  return {
    // O nome do ponto de interesse ajuda a pessoa a conferir se acertou o
    // lugar; o endereco sozinho nao diz se e a padaria certa.
    endereco: achado.poi?.name ? `${achado.poi.name} — ${endereco}` : endereco,
    lat: achado.position.lat,
    lon: achado.position.lon,
  };
}

function classificar(razao) {
  if (razao < 1.15) return 'livre';
  if (razao < 1.4) return 'um pouco carregado';
  if (razao < 1.8) return 'carregado';
  return 'travado';
}

/**
 * Tempo de carro entre dois pontos, com e sem transito.
 *
 * `computeTravelTimeFor=all` e o que faz a API devolver tambem o tempo de via
 * livre. Sem esse parametro vem so o tempo de agora, e "20 minutos" sozinho nao
 * responde "como esta o transito" — 20 minutos pode ser otimo ou terrivel.
 */
export async function calcular(origem, destino, { forcar = false } = {}) {
  if (!configurado()) throw new Error('Falta a chave do TomTom (TOMTOM_API_KEY no .env).');

  const id = `${origem.lat},${origem.lon}>${destino.lat},${destino.lon}`;
  const guardado = cache.get(id);
  if (!forcar && guardado && Date.now() - guardado.em < VALIDADE_MS) return guardado.dados;

  const url =
    `${ROTA}/${origem.lat},${origem.lon}:${destino.lat},${destino.lon}/json` +
    `?key=${encodeURIComponent(chave())}` +
    '&traffic=true&computeTravelTimeFor=all&routeType=fastest&travelMode=car';

  const resposta = await pedir(url, 'O calculo de rota');
  const r = resposta.routes?.[0]?.summary;
  if (!r) throw new Error('Nao consegui tracar o caminho entre os dois pontos.');

  const comTransito = Number(r.travelTimeInSeconds) || 0;
  const livre = Number(r.noTrafficTravelTimeInSeconds) || comTransito;
  // O proprio campo de atraso e mais confiavel que a subtracao (ele desconta
  // paradas previstas), mas ele nem sempre vem; a subtracao e a rede de baixo.
  const atraso = r.trafficDelayInSeconds != null
    ? Number(r.trafficDelayInSeconds)
    : Math.max(0, comTransito - livre);

  const dados = {
    minutos: Math.max(1, Math.round(comTransito / 60)),
    minutosLivre: Math.max(1, Math.round(livre / 60)),
    atrasoMin: Math.round(atraso / 60),
    km: Math.round((Number(r.lengthInMeters) || 0) / 100) / 10,
    situacao: classificar(livre > 0 ? comTransito / livre : 1),
    chegada: r.arrivalTime || null,
    lidoEm: new Date().toISOString(),
  };

  cache.set(id, { em: Date.now(), dados });
  return dados;
}

/**
 * Hora de chegada em "8 e 42", pra ser falada — nao "08:42:13-03:00".
 *
 * O fuso vem de JARVIS_TZ e nao do relogio do processo: Raspberry Pi OS sem
 * configurar fica em UTC, e ali `getHours()` diria 11 pra uma chegada as 8 —
 * numero errado com cara de certo, que e o pior tipo de resposta falada.
 */
export function horaDeChegada(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  let h;
  let m;
  try {
    const partes = new Intl.DateTimeFormat('pt-BR', {
      timeZone: process.env.JARVIS_TZ || 'America/Sao_Paulo',
      hour: 'numeric',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(d);
    h = Number(partes.find((x) => x.type === 'hour')?.value);
    m = Number(partes.find((x) => x.type === 'minute')?.value);
  } catch {
    // Fuso invalido no .env nao deve calar o transito inteiro.
    h = d.getHours();
    m = d.getMinutes();
  }
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return m === 0 ? `${h} horas` : `${h} e ${String(m).padStart(2, '0')}`;
}

/** Uma frase falavel. E o que a voz devolve; o app mostra a mesma coisa. */
export function emPalavras(dados, nomeDoDestino) {
  const alvo = nomeDoDestino ? ` ate ${nomeDoDestino}` : '';
  if (dados.atrasoMin < 2) {
    return `${dados.minutos} minutos${alvo}, transito livre.`;
  }
  const chega = horaDeChegada(dados.chegada);
  const fim = chega ? ` Chegando umas ${chega}.` : '';
  return `${dados.minutos} minutos${alvo}, transito ${dados.situacao} — ${dados.atrasoMin} minutos a mais que o normal.${fim}`;
}
