import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import pc from 'picocolors';
import { config } from '../core/config.js';
import { psLines } from '../platform/win32.js';
import { transcribe } from './stt.js';
import { writeWav, frameEnergy } from './wav.js';
import { casaWake } from './wake.js';

/**
 * O que faz o JARVIS comecar a ouvir.
 *
 * A wake word e o modo bonito, mas depende de uma chave da Picovoice que nem
 * todo mundo consegue tirar — o cadastro deles exige e-mail corporativo. Como
 * detectar a palavra "jarvis" e so o gatilho, e o resto da cadeia (gravar,
 * transcrever, rotear, falar) nao depende disso, existem outros dois modos que
 * nao pedem chave nenhuma.
 *
 * Todo gatilho expondo a mesma coisa:
 *   frameLength — tamanho do frame que o recorder deve usar
 *   wait()      — resolve quando for hora de escutar
 *   label       — o que imprimir na tela pro usuario saber o que fazer
 *   release()   — solta o que precisar
 */

const FRAME_LENGTH = 512;

// ─── Wake word (Porcupine) ──────────────────────────────────────────────────

async function wakeWordTrigger() {
  let Porcupine;
  let BuiltinKeyword;

  try {
    ({ Porcupine, BuiltinKeyword } = await import('@picovoice/porcupine-node'));
  } catch {
    throw new Error(
      'Pacote da wake word nao instalado. Rode:\n' +
        '  npm install @picovoice/porcupine-node\n' +
        'Ou use JARVIS_TRIGGER=hotkey, que nao precisa de chave nem desse pacote.'
    );
  }

  if (!config.voice.picovoiceKey) {
    throw new Error(
      'Falta PICOVOICE_ACCESS_KEY no .env.\n' +
        'A chave sai em https://console.picovoice.ai — mas o cadastro deles exige\n' +
        'e-mail corporativo. Se voce nao tem um, use JARVIS_TRIGGER=hotkey no .env:\n' +
        'voce aperta Ctrl+Alt+J em vez de falar a palavra, e o resto funciona igual.'
    );
  }

  const engine = config.voice.wakeWordPath
    ? new Porcupine(config.voice.picovoiceKey, [config.voice.wakeWordPath], [config.voice.sensitivity])
    : new Porcupine(
        config.voice.picovoiceKey,
        [BuiltinKeyword[config.voice.wakeWord.toUpperCase()] ?? BuiltinKeyword.JARVIS],
        [config.voice.sensitivity]
      );

  return {
    kind: 'wakeword',
    frameLength: engine.frameLength,
    label: `Diga "${config.voice.wakeWord}" pra comecar.`,
    // Unico gatilho que precisa do microfone ligado o tempo todo: e ouvindo os
    // frames que ele detecta a palavra. Os outros so abrem o mic na hora.
    needsAudio: true,
    async wait(recorder) {
      while (true) {
        const frame = await recorder.read();
        if (engine.process(frame) >= 0) return true;
      }
    },
    release: () => engine.release(),
  };
}

// ─── Escuta continua (Whisper + casamento por som) ──────────────────────────

const SAMPLE_RATE_ESCUTA = 16000;
// Piso absoluto de energia, pra microfone muito limpo.
const PISO_ABSOLUTO = 0.006;
// Quantas vezes o chiado medido ainda conta como fala. Mais baixo que o da
// captura de comando (2.5) de proposito: aqui o erro barato e transcrever um
// pedaco a toa; o erro caro e nao ouvir voce chamando.
const MARGEM_DE_RUIDO = 2.0;

/**
 * Descarta o audio que ficou na fila enquanto o assistente falava.
 *
 * O microfone nao para de gravar durante a resposta, e o gravador entrega
 * esses frames depois, de uma vez. Sem jogar fora, a primeira coisa que a
 * escuta ouve e a PROPRIA voz do assistente — e uma resposta que mencione o
 * nome dele o faz acordar sozinho, em loop.
 *
 * Frame que volta instantaneo veio da fila; frame que demora o tempo dele
 * esta chegando em tempo real. E assim que da pra saber onde a fila acaba.
 */
async function drenarFila(recorder, frameMs) {
  const TETO = 300;
  for (let i = 0; i < TETO; i++) {
    const t = Date.now();
    await recorder.read();
    if (Date.now() - t > frameMs * 0.5) return i;
  }
  return TETO;
}

/**
 * Espera alguem falar e devolve so esse pedacinho.
 *
 * Nao e a captura de comando: aqui o alvo e uma palavra, entao o pedaco e
 * curto e o silencio que o encerra tambem. Quanto menor o pedaco, mais rapido
 * o Whisper responde — e a espera entre chamar e ser ouvido e o que separa
 * "ele me escuta" de "ele demora".
 */
export async function pedacoDeFala(recorder, frameLength) {
  const frameMs = (frameLength / SAMPLE_RATE_ESCUTA) * 1000;
  const preRoll = Math.max(1, Math.ceil(300 / frameMs));
  const maxFrames = Math.ceil(config.voice.wakeMaxMs / frameMs);
  const silencioFrames = Math.max(1, Math.ceil(config.voice.wakeSilencioMs / frameMs));
  const minFrames = Math.ceil(220 / frameMs);

  const anel = [];
  let chiado = Infinity;

  // 1) Espera a energia subir. O anel guarda os ultimos 300ms: sem ele, a
  // gravacao comeca no meio do "-xis" e o Whisper recebe meia palavra.
  while (true) {
    const frame = await recorder.read();
    const energia = frameEnergy(frame);

    // Desce rapido, sobe devagar: o chiado do comodo muda quando liga o
    // ventilador, mas nao muda porque alguem falou.
    chiado = chiado === Infinity ? energia : energia < chiado ? energia : chiado * 0.999 + energia * 0.001;

    anel.push(frame);
    if (anel.length > preRoll) anel.shift();

    if (energia > Math.max(PISO_ABSOLUTO, chiado * MARGEM_DE_RUIDO)) break;
  }

  // 2) Coleta ate o silencio fechar o pedaco, ou ate o teto.
  const frames = [];
  for (const f of anel) frames.push(...f);

  let mudo = 0;
  for (let i = 0; i < maxFrames; i++) {
    const frame = await recorder.read();
    frames.push(...frame);

    const limiar = Math.max(PISO_ABSOLUTO, chiado * MARGEM_DE_RUIDO);
    if (frameEnergy(frame) > limiar) mudo = 0;
    else if (++mudo >= silencioFrames && i >= minFrames) break;
  }

  // Estalo de porta, tosse, clique de mouse: curto demais pra ser um nome.
  if (frames.length < minFrames * frameLength) return null;
  return Int16Array.from(frames);
}

/**
 * Gatilho de escuta continua.
 *
 * O Porcupine so reconhece as palavras que ele ja traz de fabrica; qualquer
 * outra exige treinar um modelo no console da Picovoice. Como o Whisper ja
 * esta na maquina e ja fica carregado, ele serve de detector — e de quebra a
 * tolerancia passa a ser um numero que voce ajusta, o que importa muito num
 * nome que a transcricao erra de dez jeitos.
 *
 * O preco e honesto: cada pedaco de fala no comodo custa uma transcricao. Por
 * isso o porteiro de energia vem antes, e o pedaco e curto.
 */
async function escutaTrigger() {
  if (!config.voice.sttServerUrl) {
    // Sem servidor, cada pedaco recarregaria o modelo do disco: ~2s por
    // barulho na sala. O remedio custaria mais que a doenca.
    throw new Error(
      'A escuta continua precisa do whisper-server no ar (STT_SERVER_URL no .env).\n' +
        'Sem ele, cada barulho da sala recarregaria o modelo do disco.\n' +
        'Rode "npm run whisper:server" numa janela, ou use JARVIS_TRIGGER=hotkey.'
    );
  }

  let ouvindoAgora = false;

  return {
    kind: 'escuta',
    frameLength: FRAME_LENGTH,
    label: `Diga ${pc.bold(`"${config.voice.wakeWord}"`)} pra comecar.`,
    needsAudio: true,

    async wait(recorder) {
      // Primeira coisa: jogar fora o que sobrou da resposta anterior.
      const frameMs = (FRAME_LENGTH / SAMPLE_RATE_ESCUTA) * 1000;
      await drenarFila(recorder, frameMs);

      while (true) {
        const pedaco = await pedacoDeFala(recorder, FRAME_LENGTH);
        if (!pedaco) continue;

        let texto;
        const arquivo = path.join(os.tmpdir(), `vexis-wake-${Date.now()}.wav`);
        try {
          writeWav(arquivo, pedaco, SAMPLE_RATE_ESCUTA);
          texto = await transcribe(arquivo);
        } catch (err) {
          // Servidor caiu no meio da noite: avisa uma vez e continua tentando.
          // Um gatilho que morre em silencio deixa a casa inteira sem voz.
          if (!ouvindoAgora) {
            console.error(pc.yellow(`[escuta] ${err.message}`));
            ouvindoAgora = true;
          }
          continue;
        } finally {
          fs.rmSync(arquivo, { force: true });
        }
        ouvindoAgora = false;

        if (!texto) continue;

        const r = casaWake(texto);
        if (config.voice.vadDebug) {
          console.log(pc.dim(`  [escuta] "${texto}" ${r.casou ? `→ acordou (d=${r.distancia})` : '→ nao era'}`));
        }
        if (!r.casou) continue;

        // Chamou e ja mandou na mesma tirada. Aproveitar isso e o que separa
        // "Vexis... (bipe) ...toca musica" de "Vexis, toca musica".
        return r.sobra ? { comando: r.sobra } : true;
      }
    },

    release: () => {},
  };
}

// ─── Tecla de atalho global ─────────────────────────────────────────────────

// Virtual-Key codes: https://learn.microsoft.com/windows/win32/inputdev/virtual-key-codes
const VK_BY_NAME = {
  ctrl: 0x11,
  alt: 0x12,
  shift: 0x10,
  space: 0x20,
  ...Object.fromEntries(
    'abcdefghijklmnopqrstuvwxyz'.split('').map((c, i) => [c, 0x41 + i])
  ),
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, 0x70 + i])),
};

function parseHotkey(spec) {
  const parts = spec.toLowerCase().split('+').map((p) => p.trim()).filter(Boolean);
  const codes = parts.map((p) => {
    const code = VK_BY_NAME[p];
    if (code === undefined) {
      throw new Error(
        `Tecla desconhecida em JARVIS_HOTKEY: "${p}". ` +
          'Use combinacoes tipo "ctrl+alt+j", "shift+space" ou "f9".'
      );
    }
    return code;
  });
  if (!codes.length) throw new Error('JARVIS_HOTKEY vazio.');
  return { codes, pretty: parts.map((p) => p[0].toUpperCase() + p.slice(1)).join('+') };
}

function hotkeyTrigger() {
  const { codes, pretty } = parseHotkey(config.voice.hotkey);

  // GetAsyncKeyState com o bit 0x8000 = tecla pressionada agora. Avisa nas duas
  // bordas: DOWN pra comecar a ouvir, UP pra saber que a pessoa terminou.
  const checks = codes.map((c) => `([K]::GetAsyncKeyState(${c}) -band 0x8000)`).join(' -and ');
  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class K { [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey); }
"@
$estava = $false
while ($true) {
  $agora = [bool](${checks})
  if ($agora -ne $estava) {
    # Direto no stdout em vez de Write-Output: o pipeline do PowerShell segura
    # a saida em buffer, e aqui a linha precisa chegar no Node na hora.
    [Console]::Out.WriteLine($(if ($agora) { "DOWN" } else { "UP" }))
    [Console]::Out.Flush()
    $estava = $agora
  }
  Start-Sleep -Milliseconds 25
}`;

  const waiters = [];
  let heldSince = 0;
  // Registrado no momento em que solta, nao deduzido do relogio depois: um
  // toque rapido tambem "passa de 400ms" alguns instantes depois, e ai o corte
  // cairia no meio da fala de quem apertou-e-falou.
  let soltouDepoisDeSegurar = false;

  const watcher = psLines(script, (line) => {
    if (line === 'DOWN') {
      heldSince = Date.now();
      soltouDepoisDeSegurar = false;
      const resolve = waiters.shift();
      if (resolve) resolve(true);
    } else if (line === 'UP') {
      if (Date.now() - heldSince > 400) soltouDepoisDeSegurar = true;
    }
  });

  return {
    kind: 'hotkey',
    frameLength: FRAME_LENGTH,
    label:
      `Aperte ${pc.bold(pretty)} pra falar` +
      pc.dim(' — segure enquanto fala e solte pra encerrar na hora.'),
    needsAudio: false,
    wait: () => new Promise((resolve) => waiters.push(resolve)),

    /**
     * Se a pessoa segurou a tecla enquanto falava, soltar e o sinal de fim —
     * exato, sem esperar silencio. Um toque rapido nao conta: aí ela quis
     * apertar-e-falar, e quem decide o fim e a deteccao de silencio.
     */
    endedByRelease: () => soltouDepoisDeSegurar,

    release: () => watcher.stop(),
  };
}

// ─── Enter no terminal ──────────────────────────────────────────────────────

function enterTrigger() {
  const rl = readline.createInterface({ input: process.stdin });
  const waiters = [];

  rl.on('line', () => {
    const resolve = waiters.shift();
    if (resolve) resolve(true);
  });

  return {
    kind: 'enter',
    frameLength: FRAME_LENGTH,
    label: `Aperte ${pc.bold('Enter')} pra falar (o terminal precisa estar em foco).`,
    needsAudio: false,
    wait: () => new Promise((resolve) => waiters.push(resolve)),
    release: () => rl.close(),
  };
}

// ─── Escolha ────────────────────────────────────────────────────────────────

const TRIGGERS = {
  wakeword: wakeWordTrigger,
  escuta: escutaTrigger,
  hotkey: hotkeyTrigger,
  enter: enterTrigger,
};

export async function createTrigger() {
  const wanted = config.voice.trigger;
  const build = TRIGGERS[wanted];
  if (!build) {
    throw new Error(
      `JARVIS_TRIGGER="${wanted}" nao existe. Use escuta, wakeword, hotkey ou enter.`
    );
  }
  return build();
}
