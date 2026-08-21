import fs from 'node:fs';
import path from 'node:path';
import { config, ensureDirs } from './config.js';

/**
 * Preferencias do usuario — o que o app de celular edita e o HUD obedece.
 *
 * Fica em JSON no vault, e nao no `.env`, por um motivo simples: `.env` e
 * configuracao de quem instala, escrita uma vez com o editor aberto. Isto aqui
 * e configuracao de quem USA, mudada do celular, no meio do dia, sem terminal
 * nenhum. Misturar as duas foi o que corrompeu o `.env` tres vezes.
 *
 * Toda leitura passa por um merge com os padroes. Assim um arquivo gravado por
 * uma versao antiga nao fica sem os campos novos — o HUD leria `undefined` e
 * desenharia buraco.
 */

const PADRAO = {
  // Identidade do aparelho. O nome e o que voce da no pareamento ("Sala",
  // "Quarto") e o que aparece na lista do celular.
  dispositivo: {
    nome: null,
    id: null,
  },

  aparencia: {
    // Minimal | Editorial | Vidro — as tres do mockup.
    variante: 'Editorial',
    // Ids das fotos enviadas pelo celular. Vazio = fundo preto.
    fotos: [],
    // Troca de foto sozinha. 0 desliga e fixa na primeira.
    rotacaoMin: 30,
    // Escurecimento por cima da foto, pra letra branca ter contraste.
    scrim: 30,
    acento: '#19c0dd',
  },

  brilho: {
    // Sem agenda, o brilho e so o que voce deixou no controle.
    auto: true,
    nivel: 85,
    // Faixas do dia. A primeira que casar com a hora atual manda.
    // Fora de todas, cai no `nivel`.
    agenda: [
      { de: '06:00', ate: '18:00', nivel: 100 },
      { de: '18:00', ate: '22:00', nivel: 60 },
      { de: '22:00', ate: '06:00', nivel: 25 },
    ],
  },

  volume: {
    nivel: 60,
    // Silencio noturno: avisos falados nao tocam dentro desta faixa.
    silencioDe: '23:00',
    silencioAte: '07:00',
    silencioAtivo: true,
  },

  tempo: {
    ativo: true,
    // Onde. Sem isso a previsao nao tem o que consultar.
    local: { nome: null, lat: null, lon: null },
    // Janela em que o bloco de tempo aparece no HUD.
    mostrarDe: '06:00',
    mostrarAte: '12:00',
    // Fora da janela ele some — a nao ser que va chover, que e justamente
    // quando voce quer saber sem ter perguntado.
    forcarSeChuva: true,
    chuvaMinima: 50,
    // Quantas horas a frente olhar pra decidir se "vai chover".
    horasAFrente: 6,
  },

  // "Quinta-feira tirar o lixo, das 8h as 21h".
  avisos: [],

  compras: [],

  casa: {
    // Home Assistant e o unico jeito honesto de falar com Xiaomi, Tuya e
    // Zigbee sem uma nuvem por fabricante. Veja `.skills/casa.md`.
    baseUrl: null,
    token: null,
    favoritos: [],
  },
};

function arquivo() {
  ensureDirs();
  return path.join(config.vaultPath, 'settings.json');
}

/** Merge fundo a fundo. Objeto o padrao completa; array o usuario substitui. */
function fundir(padrao, salvo) {
  if (Array.isArray(padrao)) return Array.isArray(salvo) ? salvo : padrao;
  if (padrao && typeof padrao === 'object') {
    const saida = { ...padrao };
    if (salvo && typeof salvo === 'object') {
      for (const chave of Object.keys(salvo)) {
        saida[chave] = chave in padrao ? fundir(padrao[chave], salvo[chave]) : salvo[chave];
      }
    }
    return saida;
  }
  return salvo === undefined ? padrao : salvo;
}

export function lerSettings() {
  try {
    const bruto = fs.readFileSync(arquivo(), 'utf8');
    return fundir(PADRAO, JSON.parse(bruto));
  } catch {
    // Nao existe ainda, ou alguem editou a mao e quebrou o JSON. Nos dois
    // casos os padroes servem — HUD sem preferencia e melhor que HUD sem tela.
    return fundir(PADRAO, {});
  }
}

/**
 * Grava um pedaco. Recebe patch parcial porque quem edita e uma tela de
 * celular mexendo num campo de cada vez, nao um arquivo inteiro.
 */
export function gravarSettings(patch) {
  const atual = lerSettings();
  const novo = fundir(atual, patch || {});
  const destino = arquivo();

  // Grava em temporario e renomeia: se a energia cair no meio da escrita, o
  // arquivo bom continua la em vez de virar meio JSON.
  const temp = `${destino}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(novo, null, 2), 'utf8');
  fs.renameSync(temp, destino);
  return novo;
}

export function padroesDeSettings() {
  return fundir(PADRAO, {});
}

/** "08:30" → 510. Devolve null pro que nao for hora. */
export function minutosDoDia(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * A hora esta dentro da janela?
 *
 * Trata janela que cruza a meia-noite (22:00 → 06:00), que e o caso do modo
 * noturno e do silencio. Comparar `de <= agora && agora < ate` direto daria
 * falso a noite inteira justamente quando a regra deveria valer.
 */
export function dentroDaJanela(de, ate, quando = new Date()) {
  const inicio = minutosDoDia(de);
  const fim = minutosDoDia(ate);
  if (inicio === null || fim === null) return false;

  const agora = quando.getHours() * 60 + quando.getMinutes();
  if (inicio === fim) return true; // 24h
  if (inicio < fim) return agora >= inicio && agora < fim;
  return agora >= inicio || agora < fim; // cruza a meia-noite
}

/** O brilho que a agenda pede agora, ou o nivel fixo se nenhuma faixa casar. */
export function brilhoDoMomento(quando = new Date(), settings = lerSettings()) {
  const { auto, nivel, agenda } = settings.brilho;
  if (!auto) return nivel;
  for (const faixa of agenda || []) {
    if (dentroDaJanela(faixa.de, faixa.ate, quando)) return faixa.nivel;
  }
  return nivel;
}
