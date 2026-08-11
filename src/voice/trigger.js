import readline from 'node:readline';
import pc from 'picocolors';
import { config } from '../core/config.js';
import { psLines } from '../platform/win32.js';

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

  // GetAsyncKeyState com o bit 0x8000 = tecla pressionada agora. O sleep depois
  // do disparo evita repetir enquanto a pessoa ainda nao soltou.
  const checks = codes.map((c) => `([K]::GetAsyncKeyState(${c}) -band 0x8000)`).join(' -and ');
  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class K { [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey); }
"@
while ($true) {
  if (${checks}) {
    # Direto no stdout em vez de Write-Output: o pipeline do PowerShell segura
    # a saida em buffer, e aqui a linha precisa chegar no Node na hora.
    [Console]::Out.WriteLine("TRIGGER")
    [Console]::Out.Flush()
    Start-Sleep -Milliseconds 800
  }
  Start-Sleep -Milliseconds 40
}`;

  const waiters = [];
  const watcher = psLines(script, () => {
    const resolve = waiters.shift();
    if (resolve) resolve(true);
  });

  return {
    kind: 'hotkey',
    frameLength: FRAME_LENGTH,
    label: `Aperte ${pc.bold(pretty)} pra falar (funciona com o terminal em segundo plano).`,
    needsAudio: false,
    wait: () => new Promise((resolve) => waiters.push(resolve)),
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
  hotkey: hotkeyTrigger,
  enter: enterTrigger,
};

export async function createTrigger() {
  const wanted = config.voice.trigger;
  const build = TRIGGERS[wanted];
  if (!build) {
    throw new Error(
      `JARVIS_TRIGGER="${wanted}" nao existe. Use wakeword, hotkey ou enter.`
    );
  }
  return build();
}
