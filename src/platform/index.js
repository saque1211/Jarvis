/**
 * Despachante de plataforma.
 *
 * O HUD e o app do celular falam SO com este arquivo. Eles nao sabem se do
 * outro lado tem um PowerShell ou um nmcli — pedem "lista as redes" e recebem
 * a mesma forma de objeto nos dois casos.
 *
 * O import e dinamico de proposito: carregar o win32.js no Raspberry traria
 * junto um monte de codigo de PowerShell que nunca vai rodar, e carregar o
 * linux.js no Windows, idem.
 */

const ALVO = process.platform;

async function modulo() {
  if (ALVO === 'win32') return import('./win32.js');
  if (ALVO === 'linux') return import('./linux.js');
  throw new Error(
    `A central de controle nao tem camada pra ${ALVO}. Existem duas: Windows e Linux (Raspberry).`
  );
}

/**
 * O que ESTA maquina consegue fazer.
 *
 * O HUD usa isto pra decidir o que desenhar. Um controle de brilho que nao
 * mexe em nada e pior que nenhum: a pessoa arrasta, nada acontece, e ela passa
 * a duvidar do resto da tela.
 */
export async function capacidades() {
  const base = {
    plataforma: ALVO,
    wifi: false,
    brilho: false,
    brilhoExato: false,
    volume: false,
    volumeExato: false,
    reiniciar: false,
  };

  try {
    const m = await modulo();
    base.wifi = typeof m.listarRedes === 'function';
    base.reiniciar = typeof m.reiniciarDispositivo === 'function';

    // Brilho e volume dependem do hardware, nao so do SO: notebook tem WMI de
    // brilho, monitor de mesa nao; o Pi so tem se a regra de udev existir. A
    // unica resposta honesta vem de tentar ler.
    const brilho = await m.lerBrilho().catch(() => null);
    base.brilho = brilho !== null;
    base.brilhoExato = brilho !== null;

    const volume = await m.lerVolume().catch(() => null);
    base.volume = true; // sempre da pra mandar, mesmo sem conseguir ler
    base.volumeExato = volume !== null;
  } catch {
    // Plataforma sem camada: devolve tudo desligado em vez de estourar. O HUD
    // some com os controles e continua mostrando relogio, tempo e avisos.
  }

  return base;
}

export async function listarRedes() {
  const m = await modulo();
  return m.listarRedes();
}

export async function redeAtual() {
  const m = await modulo();
  return m.redeAtual();
}

export async function conectarRede(ssid, senha) {
  const m = await modulo();
  return m.conectarRede(ssid, senha);
}

export async function lerBrilho() {
  const m = await modulo();
  return m.lerBrilho();
}

export async function definirBrilho(percentual) {
  const m = await modulo();
  return m.definirBrilho(percentual);
}

export async function lerVolume() {
  const m = await modulo();
  return m.lerVolume();
}

/**
 * `anterior` so importa no Windows, onde o volume se move por teclas de midia
 * e o ajuste e relativo: sem saber de onde saiu, nao da pra saber quantos
 * passos dar. No Linux o valor e absoluto e o parametro e ignorado.
 */
export async function definirVolume(percentual, anterior = null) {
  const m = await modulo();
  return m.definirVolume(percentual, anterior);
}

export async function reiniciarDispositivo() {
  const m = await modulo();
  return m.reiniciarDispositivo();
}
