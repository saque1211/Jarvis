import fs from 'node:fs';
import path from 'node:path';
import { run } from './exec.js';

/**
 * Camada Linux — o irmao do win32.js, pro Raspberry.
 *
 * Cobre so o que a central de controle do HUD precisa: rede, brilho, volume e
 * reiniciar. As 69 tools de Windows continuam sendo de Windows; o Pi nao tenta
 * fingir que abre o Explorer.
 *
 * Regra que vale nos dois lados: nada de montar comando como string de shell.
 * Tudo vai por `run(cmd, argsArray)`, entao um SSID com aspas ou ponto-e-virgula
 * e so um argumento esquisito, nunca um comando novo.
 */

export const isLinux = process.platform === 'linux';

/**
 * Quebra uma linha do `nmcli -t`. Os campos vem separados por `:`, e um `:`
 * dentro do valor vem escapado como `\:` — split(':') puro parte SSID no meio
 * e faz a rede aparecer com nome truncado na lista.
 */
export function quebrarLinhaNmcli(linha) {
  const campos = [];
  let atual = '';
  for (let i = 0; i < linha.length; i++) {
    const c = linha[i];
    if (c === '\\' && i + 1 < linha.length) {
      atual += linha[++i];
    } else if (c === ':') {
      campos.push(atual);
      atual = '';
    } else {
      atual += c;
    }
  }
  campos.push(atual);
  return campos;
}

/**
 * Tem radio Wi-Fi nesta maquina?
 *
 * Lista os dispositivos, sem varrer o ar — e uma pergunta ao NetworkManager,
 * nao ao radio. Serve pro HUD decidir se desenha o controle de Wi-Fi.
 */
export async function wifiDisponivel() {
  const r = await run('nmcli', ['-t', '-f', 'TYPE', 'device'], { timeoutMs: 8000 });
  if (!r.ok) return false;
  return r.stdout.split('\n').some((l) => l.trim() === 'wifi');
}

/** As redes que o radio esta enxergando agora. */
export async function listarRedes() {
  const r = await run(
    'nmcli',
    ['-t', '-f', 'IN-USE,SSID,SIGNAL,SECURITY', 'device', 'wifi', 'list', '--rescan', 'auto'],
    { timeoutMs: 15000 }
  );
  if (!r.ok) {
    throw new Error(
      r.code === -1
        ? 'nmcli nao encontrado — o NetworkManager e quem lista as redes no Raspberry Pi OS.'
        : `nmcli falhou: ${r.stderr || r.stdout}`
    );
  }

  const vistas = new Map();
  for (const linha of r.stdout.split('\n')) {
    if (!linha.trim()) continue;
    const [emUso, ssid, sinal, seguranca] = quebrarLinhaNmcli(linha);
    // Rede oculta vem com SSID vazio: nao da pra clicar nela de qualquer jeito.
    if (!ssid) continue;

    // O mesmo SSID aparece uma vez por ponto de acesso. Pra lista, o que
    // importa e o melhor sinal — mostrar "Casa_5G" tres vezes so confunde.
    const forca = Number(sinal) || 0;
    const anterior = vistas.get(ssid);
    vistas.set(ssid, {
      nome: ssid,
      // Fica sempre o melhor sinal visto, mesmo quando quem esta conectado e
      // um ponto de acesso mais fraco: a lista serve pra escolher rede, e a
      // rede e a mesma.
      sinal: Math.max(forca, anterior?.sinal ?? 0),
      protegida: Boolean(seguranca && seguranca !== '--') || anterior?.protegida === true,
      conectada: emUso === '*' || anterior?.conectada === true,
    });
  }

  return [...vistas.values()].sort((a, b) => {
    if (a.conectada !== b.conectada) return a.conectada ? -1 : 1;
    return b.sinal - a.sinal;
  });
}

/** A rede conectada agora, ou null. */
export async function redeAtual() {
  const r = await run('nmcli', ['-t', '-f', 'NAME,TYPE', 'connection', 'show', '--active']);
  if (!r.ok) return null;
  for (const linha of r.stdout.split('\n')) {
    const [nome, tipo] = quebrarLinhaNmcli(linha);
    if (tipo === '802-11-wireless') return nome;
  }
  return null;
}

/**
 * Conecta. Sem senha, tenta como rede aberta — que e o certo pra "Convidados"
 * e o errado pra qualquer outra, entao o erro do nmcli passa inteiro pra cima.
 */
export async function conectarRede(ssid, senha) {
  if (!ssid) throw new Error('Sem SSID.');
  const args = ['device', 'wifi', 'connect', ssid];
  if (senha) args.push('password', senha);

  const r = await run('nmcli', args, { timeoutMs: 45000 });
  if (r.ok) return { ok: true, rede: ssid };

  const saida = `${r.stderr} ${r.stdout}`;
  if (/Secrets were required|no valid key|incorrect/i.test(saida)) {
    return { ok: false, erro: 'Senha recusada pela rede.' };
  }
  if (/No network with SSID/i.test(saida)) {
    return { ok: false, erro: `Nao achei a rede "${ssid}" no ar.` };
  }
  return { ok: false, erro: (r.stderr || r.stdout || 'nmcli falhou').slice(0, 200) };
}

/**
 * Brilho. Duas realidades diferentes: a tela oficial do Pi aparece em
 * /sys/class/backlight e se controla escrevendo um numero; monitor por HDMI so
 * obedece DDC/CI, que e o `ddcutil`. Tenta a primeira, cai na segunda.
 */
function painelDeBacklight() {
  const base = '/sys/class/backlight';
  try {
    const [primeiro] = fs.readdirSync(base);
    return primeiro ? path.join(base, primeiro) : null;
  } catch {
    return null;
  }
}

export async function lerBrilho() {
  const painel = painelDeBacklight();
  if (painel) {
    try {
      const atual = Number(fs.readFileSync(path.join(painel, 'brightness'), 'utf8').trim());
      const max = Number(fs.readFileSync(path.join(painel, 'max_brightness'), 'utf8').trim());
      if (max > 0) return Math.round((atual / max) * 100);
    } catch {
      // Sem permissao de leitura: cai no ddcutil.
    }
  }

  const r = await run('ddcutil', ['getvcp', '10', '--brief'], { timeoutMs: 10000 });
  if (r.ok) {
    // "VCP 10 C 45 100" → atual 45, maximo 100.
    const p = r.stdout.trim().split(/\s+/);
    const atual = Number(p[3]);
    const max = Number(p[4]);
    if (max > 0) return Math.round((atual / max) * 100);
  }
  return null;
}

export async function definirBrilho(percentual) {
  const alvo = Math.max(0, Math.min(100, Math.round(Number(percentual))));
  if (!Number.isFinite(alvo)) throw new Error('Brilho invalido.');

  const painel = painelDeBacklight();
  if (painel) {
    try {
      const max = Number(fs.readFileSync(path.join(painel, 'max_brightness'), 'utf8').trim());
      // Piso de 1: zerar o backlight apaga a tela e nao ha como voltar pela
      // propria tela. O controle deslizante nao pode ser um jeito de se trancar
      // do lado de fora.
      const valor = Math.max(1, Math.round((alvo / 100) * max));
      fs.writeFileSync(path.join(painel, 'brightness'), String(valor));
      return { ok: true, nivel: alvo, via: 'backlight' };
    } catch (err) {
      if (err.code !== 'EACCES') throw err;
      // Sem permissao: e o caso comum sem a regra de udev. Tenta o ddcutil e,
      // se tambem falhar, a mensagem la embaixo explica o conserto.
    }
  }

  const r = await run('ddcutil', ['setvcp', '10', String(alvo)], { timeoutMs: 15000 });
  if (r.ok) return { ok: true, nivel: alvo, via: 'ddcutil' };

  throw new Error(
    'Sem permissao pra mudar o brilho. Na tela oficial do Pi, libere com uma regra de udev ' +
      'pra /sys/class/backlight; em monitor HDMI, instale o ddcutil e habilite DDC/CI no monitor.'
  );
}

/** Volume. PipeWire e o padrao no Pi OS atual; ALSA cobre as imagens antigas. */
export async function lerVolume() {
  const wp = await run('wpctl', ['get-volume', '@DEFAULT_AUDIO_SINK@']);
  if (wp.ok) {
    const m = /Volume:\s*([\d.]+)/.exec(wp.stdout);
    if (m) return { nivel: Math.round(Number(m[1]) * 100), mudo: /MUTED/i.test(wp.stdout) };
  }

  const am = await run('amixer', ['-M', 'sget', 'Master']);
  if (am.ok) {
    const m = /\[(\d+)%\].*?\[(on|off)\]/s.exec(am.stdout);
    if (m) return { nivel: Number(m[1]), mudo: m[2] === 'off' };
  }
  return null;
}

export async function definirVolume(percentual) {
  const alvo = Math.max(0, Math.min(100, Math.round(Number(percentual))));
  if (!Number.isFinite(alvo)) throw new Error('Volume invalido.');

  const wp = await run('wpctl', ['set-volume', '@DEFAULT_AUDIO_SINK@', `${alvo}%`]);
  if (wp.ok) return { ok: true, nivel: alvo, via: 'wpctl' };

  const am = await run('amixer', ['-M', 'sset', 'Master', `${alvo}%`]);
  if (am.ok) return { ok: true, nivel: alvo, via: 'amixer' };

  throw new Error('Nao consegui mudar o volume (nem wpctl nem amixer responderam).');
}

export async function reiniciarDispositivo() {
  const r = await run('systemctl', ['reboot'], { timeoutMs: 10000 });
  if (r.ok) return { ok: true };
  throw new Error(
    `Nao consegui reiniciar: ${r.stderr || r.stdout || 'systemctl recusou'}. ` +
      'Provavelmente falta permissao — o servico do VEXIS precisa poder chamar systemctl reboot.'
  );
}
