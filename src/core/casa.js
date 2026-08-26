import { config } from './config.js';
import { lerSettings } from './settings.js';

/**
 * Casa inteligente — a ponte com o Home Assistant.
 *
 * Home Assistant e o caminho honesto: ele ja fala com Xiaomi, Tuya, Zigbee e
 * mais quinze protocolos por baixo, com uma REST simples e um token. Integro UM
 * intermediario em vez de uma nuvem por fabricante. Ver `.skills/casa.md`.
 *
 * A config pode vir de dois lugares, e a ordem importa: o que a pessoa pos pelo
 * APP (settings.casa) manda; sem isso, vale o que veio do `.env`
 * (config.homeAssistant). Assim da pra ligar a casa do celular, sem terminal —
 * mas quem instalou escrevendo o .env continua valendo.
 */

// Dominios que um botao liga/desliga. Sensor, sun, person e afins nao entram —
// nao ha o que "ligar" neles, e virariam botao que engana.
const CONTROLAVEIS = [
  'light', 'switch', 'fan', 'climate', 'media_player',
  'cover', 'input_boolean', 'scene', 'script', 'automation',
];

// O que conta como "ligado" varia por dominio: luz e 'on', persiana e 'open',
// media e 'playing'. Sem isto o botao da persiana mostraria o estado errado.
function estaLigado(estado) {
  return estado === 'on' || estado === 'open' || estado === 'playing' || estado === 'home';
}

export function casaConfig() {
  const s = lerSettings().casa || {};
  return {
    baseUrl: String(s.baseUrl || config.homeAssistant.baseUrl || '').replace(/\/$/, ''),
    token: s.token || config.homeAssistant.token || '',
    favoritos: Array.isArray(s.favoritos) ? s.favoritos : [],
  };
}

export function casaConfigurada() {
  const c = casaConfig();
  return Boolean(c.baseUrl && c.token);
}

/**
 * Uma chamada na REST do Home Assistant. Timeout curto de proposito: se o HA
 * estiver fora do ar, o app nao pode ficar rodando pra sempre esperando — um
 * erro rapido e melhor que um botao travado.
 */
export async function chamarHA(endpoint, options = {}) {
  const { baseUrl, token } = casaConfig();
  if (!baseUrl || !token) {
    throw new Error('Casa não configurada — falta a URL e o token do Home Assistant.');
  }
  const res = await fetch(`${baseUrl}/api${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
    signal: AbortSignal.timeout(Number(process.env.HOME_ASSISTANT_TIMEOUT_MS || 8000)),
  });
  if (!res.ok) {
    throw new Error(`Home Assistant ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/** Testa a conexao (usada pelo "Testar e salvar" do app). Devolve o nome da casa. */
export async function testarCasa() {
  const info = await chamarHA('/config');
  return { ok: true, nome: info?.location_name || 'Casa', versao: info?.version || null };
}

function resumir(e) {
  const dominio = e.entity_id.split('.')[0];
  return {
    id: e.entity_id,
    nome: e.attributes?.friendly_name || e.entity_id,
    dominio,
    estado: e.state,
    ligado: estaLigado(e.state),
  };
}

/** Todos os dispositivos que da pra controlar — pra escolher os favoritos. */
export async function listarDispositivos() {
  const estados = await chamarHA('/states');
  return estados
    .filter((e) => CONTROLAVEIS.includes(e.entity_id.split('.')[0]))
    .map(resumir)
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
}

/** Liga, desliga ou alterna um dispositivo. */
export async function acaoDispositivo(entityId, acao = 'toggle') {
  if (!/^[a-z_]+\.[a-z0-9_]+$/i.test(String(entityId))) {
    throw new Error('entity_id inválido.');
  }
  const dominio = entityId.split('.')[0];
  const servicos = { turn_on: 'turn_on', turn_off: 'turn_off', toggle: 'toggle' };
  const servico = servicos[acao] || 'toggle';
  await chamarHA(`/services/${dominio}/${servico}`, {
    method: 'POST',
    body: JSON.stringify({ entity_id: entityId }),
  });
  return true;
}

/**
 * Estado ao vivo so dos favoritos — o que o app desenha como botoes rapidos.
 * Uma leitura de /states so, casada com a lista de favoritos, pra nao fazer uma
 * chamada por botao.
 */
export async function estadoFavoritos() {
  const { favoritos } = casaConfig();
  if (!favoritos.length) return [];
  const estados = await chamarHA('/states');
  const mapa = new Map(estados.map((e) => [e.entity_id, e]));
  return favoritos.map((id) => {
    const e = mapa.get(id);
    if (!e) return { id, nome: id, dominio: id.split('.')[0], estado: 'indisponível', ligado: false, disponivel: false };
    return { ...resumir(e), disponivel: true };
  });
}
