import { lerSettings, gravarSettings, dentroDaJanela, minutosDoDia } from './settings.js';

/**
 * Avisos recorrentes: "quinta-feira tirar o lixo, das 8h as 21h".
 *
 * A diferenca pro lembrete comum (`skills/notify.js`) e a JANELA. Um lembrete
 * dispara num instante e some; se voce estava no banho, perdeu. Um aviso fica
 * na tela o dia inteiro dentro da faixa que voce escolheu, ate voce dizer que
 * fez. Pra lixo, remedio e academia, o instante nao serve — o que serve e
 * "ainda esta pendente".
 */

const DIAS = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];

/** Aceita o que a voz produz: "quinta", "quinta-feira", "qui", "terça". */
export function diaDaSemana(texto) {
  const limpo = String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/-?feira/g, '')
    .trim();

  if (!limpo) return null;
  if (limpo === 'hoje') return new Date().getDay();
  if (limpo === 'amanha') return (new Date().getDay() + 1) % 7;

  const exato = DIAS.indexOf(limpo);
  if (exato >= 0) return exato;

  // Prefixo: "seg", "ter", "qui". "sab"/"sabado" tambem cai aqui.
  const porPrefixo = DIAS.findIndex((d) => d.startsWith(limpo) && limpo.length >= 3);
  return porPrefixo >= 0 ? porPrefixo : null;
}

export function nomeDoDia(indice) {
  return DIAS[indice] || '?';
}

function hojeISO(quando = new Date()) {
  const d = new Date(quando);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}

export function listar() {
  return lerSettings().avisos;
}

export function criar({ texto, dias, de = '08:00', ate = '21:00' }) {
  if (!texto?.trim()) throw new Error('Aviso sem texto.');
  if (minutosDoDia(de) === null || minutosDoDia(ate) === null) {
    throw new Error('Horario invalido — use o formato 08:00.');
  }

  const listaDias = (Array.isArray(dias) ? dias : [dias])
    .map((d) => (typeof d === 'number' ? d : diaDaSemana(d)))
    .filter((d) => d !== null && d >= 0 && d <= 6);

  if (!listaDias.length) throw new Error('Nao entendi em que dia.');

  const avisos = listar();
  const aviso = {
    id: Math.max(0, ...avisos.map((a) => a.id || 0)) + 1,
    texto: texto.trim(),
    dias: [...new Set(listaDias)].sort(),
    de,
    ate,
    ativo: true,
    feitoEm: null,
  };
  gravarSettings({ avisos: [...avisos, aviso] });
  return aviso;
}

export function remover(id) {
  const avisos = listar();
  const alvo = avisos.find((a) => a.id === Number(id));
  if (!alvo) return null;
  gravarSettings({ avisos: avisos.filter((a) => a.id !== Number(id)) });
  return alvo;
}

/** Marca como feito HOJE. Amanha ele volta sozinho — e a graca de ser semanal. */
export function concluir(id, quando = new Date()) {
  const avisos = listar();
  const alvo = avisos.find((a) => a.id === Number(id));
  if (!alvo) return null;
  gravarSettings({
    avisos: avisos.map((a) => (a.id === Number(id) ? { ...a, feitoEm: hojeISO(quando) } : a)),
  });
  return { ...alvo, feitoEm: hojeISO(quando) };
}

/**
 * O que esta pendente neste instante.
 *
 * Tres condicoes juntas: hoje e um dos dias, a hora esta na janela, e ninguem
 * marcou como feito hoje. Sem a terceira, o card ficaria na tela depois de voce
 * ja ter descido com o lixo, e em uma semana voce para de olhar pra ele.
 */
export function pendentes(quando = new Date()) {
  const hoje = hojeISO(quando);
  const diaAtual = quando.getDay();

  return listar()
    .filter((a) => a.ativo !== false)
    .filter((a) => a.dias.includes(diaAtual))
    .filter((a) => a.feitoEm !== hoje)
    .filter((a) => dentroDaJanela(a.de, a.ate, quando))
    .map((a) => ({
      id: a.id,
      texto: a.texto,
      de: a.de,
      ate: a.ate,
      // Quanto ainda resta da janela. O HUD usa pra dar urgencia no fim do dia.
      minutosRestantes: restanteDaJanela(a.ate, quando),
    }))
    .sort((a, b) => a.minutosRestantes - b.minutosRestantes);
}

function restanteDaJanela(ate, quando) {
  const fim = minutosDoDia(ate);
  const agora = quando.getHours() * 60 + quando.getMinutes();
  const bruto = fim - agora;
  // Janela que cruza a meia-noite: o fim e amanha, entao soma o dia inteiro.
  return bruto >= 0 ? bruto : bruto + 24 * 60;
}

/** Frase falavel — o daemon usa quando voce pergunta o que tem pra hoje. */
export function emPalavras(quando = new Date()) {
  const lista = pendentes(quando);
  if (!lista.length) return 'Nada pendente agora.';
  if (lista.length === 1) return `Falta ${lista[0].texto}.`;
  const nomes = lista.map((a) => a.texto);
  return `Faltam ${nomes.slice(0, -1).join(', ')} e ${nomes.at(-1)}.`;
}
