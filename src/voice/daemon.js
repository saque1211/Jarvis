#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import pc from 'picocolors';
import { config, ensureDirs } from '../core/config.js';
import { route } from '../core/router.js';
import { transcribe, sttEngineName } from './stt.js';
import { speak } from './tts.js';
import { writeWav, frameEnergy } from './wav.js';
import { checkDueReminders } from '../skills/notify.js';

/**
 * Daemon de voz: escuta a wake word, grava o comando ate voce parar de falar,
 * transcreve local, roteia pro Claude e responde em voz alta.
 *
 * O loop tambem dispara os lembretes vencidos — assim nao existe um segundo
 * processo agendador pra manter vivo.
 */

const SAMPLE_RATE = 16000;
const SILENCE_THRESHOLD = 0.012; // RMS abaixo disso conta como silencio

let porcupine = null;
let recorder = null;
let running = true;

function log(label, message, color = pc.dim) {
  console.log(`${color(`[${label}]`)} ${message}`);
}

async function loadPorcupine() {
  let Porcupine;
  let BuiltinKeyword;
  let PvRecorder;

  try {
    ({ Porcupine, BuiltinKeyword } = await import('@picovoice/porcupine-node'));
    ({ PvRecorder } = await import('@picovoice/pvrecorder-node'));
  } catch {
    throw new Error(
      'Pacotes de wake word nao instalados. Rode:\n' +
        '  npm install @picovoice/porcupine-node @picovoice/pvrecorder-node'
    );
  }

  if (!config.voice.picovoiceKey) {
    throw new Error(
      'Falta PICOVOICE_ACCESS_KEY no .env.\n' +
        'Pegue a chave gratuita em https://console.picovoice.ai — o plano free cobre uso pessoal.'
    );
  }

  // Keyword customizada (.ppn) tem prioridade; senao usamos a "jarvis" de fabrica.
  const engine = config.voice.wakeWordPath
    ? new Porcupine(config.voice.picovoiceKey, [config.voice.wakeWordPath], [config.voice.sensitivity])
    : new Porcupine(
        config.voice.picovoiceKey,
        [BuiltinKeyword[config.voice.wakeWord.toUpperCase()] ?? BuiltinKeyword.JARVIS],
        [config.voice.sensitivity]
      );

  return { engine, PvRecorder };
}

/**
 * Grava depois da wake word ate detectar silencio sustentado ou estourar o
 * tempo maximo. Devolve os frames concatenados.
 */
async function captureCommand() {
  const frames = [];
  const silenceFramesNeeded = Math.ceil(
    config.voice.silenceMs / ((porcupine.frameLength / SAMPLE_RATE) * 1000)
  );
  const maxFrames = Math.ceil(
    config.voice.maxCommandMs / ((porcupine.frameLength / SAMPLE_RATE) * 1000)
  );

  let silentRun = 0;
  let spoke = false;

  for (let i = 0; i < maxFrames; i++) {
    const frame = await recorder.read();
    frames.push(...frame);

    const energy = frameEnergy(frame);
    if (energy > SILENCE_THRESHOLD) {
      spoke = true;
      silentRun = 0;
    } else if (spoke) {
      // So conta silencio depois que a pessoa comecou a falar; senao a gente
      // corta antes de ela abrir a boca.
      silentRun++;
      if (silentRun >= silenceFramesNeeded) break;
    } else if (i > silenceFramesNeeded * 3) {
      // Wake word disparou mas ninguem falou nada: aborta.
      return null;
    }
  }

  return spoke ? Int16Array.from(frames) : null;
}

async function handleUtterance() {
  log('escuta', pc.cyan('wake word detectada — pode falar'), pc.cyan);

  const audio = await captureCommand();
  if (!audio) {
    log('escuta', 'nao ouvi nada, voltando a dormir');
    return;
  }

  const wavPath = path.join(os.tmpdir(), `jarvis-${Date.now()}.wav`);
  writeWav(wavPath, audio, SAMPLE_RATE);

  let text;
  try {
    text = await transcribe(wavPath);
  } catch (err) {
    log('stt', pc.red(err.message), pc.red);
    await speak('Nao consegui transcrever. Confira a configuracao do STT.');
    return;
  } finally {
    fs.rmSync(wavPath, { force: true });
  }

  if (!text || text.length < 2) {
    log('stt', 'transcricao vazia');
    return;
  }

  log('voce', pc.white(text), pc.green);

  try {
    const { reply, steps } = await route(text, {
      source: 'voice',
      onStep: ({ tool }) => log('tool', pc.yellow(tool), pc.yellow),
    });
    log('jarvis', pc.white(reply), pc.magenta);
    if (steps.some((s) => !s.ok)) {
      log('aviso', pc.yellow(`${steps.filter((s) => !s.ok).length} tool(s) falharam`), pc.yellow);
    }
    await speak(reply);
  } catch (err) {
    log('erro', pc.red(err.message), pc.red);
    await speak('Deu erro aqui. Confira o terminal.');
  }
}

async function main() {
  ensureDirs();

  console.log(pc.bold(pc.cyan('\n  JARVIS')));
  console.log(pc.dim('  SPEAK. ROUTE. REMEMBER. REPEAT.\n'));

  const engine = await sttEngineName();
  log('stt', engine ? pc.green(engine) : pc.red('nenhum motor encontrado'), engine ? pc.green : pc.red);
  log('tts', config.voice.ttsCommand ? 'TTS_COMMAND' : 'SAPI (voz nativa do Windows)');
  log('modelo', config.model);

  const { engine: porcupineEngine, PvRecorder } = await loadPorcupine();
  porcupine = porcupineEngine;

  recorder = new PvRecorder(porcupine.frameLength, config.voice.micIndex);
  recorder.start();

  log('mic', pc.green(recorder.getSelectedDevice()), pc.green);
  console.log(pc.bold(pc.cyan(`\n  Ouvindo. Diga "${config.voice.wakeWord}" pra comecar.\n`)));

  // Lembretes: checa a cada 30s no mesmo processo.
  const reminderTimer = setInterval(async () => {
    try {
      const fired = await checkDueReminders();
      for (const reminder of fired) {
        log('lembrete', pc.yellow(reminder.message), pc.yellow);
        await speak(reminder.message);
      }
    } catch {
      // Um lembrete que falhou nao pode derrubar a escuta.
    }
  }, 30000);

  while (running) {
    const frame = await recorder.read();
    if (porcupine.process(frame) >= 0) {
      await handleUtterance();
      console.log(pc.dim(`\n  ...ouvindo de novo\n`));
    }
  }

  clearInterval(reminderTimer);
}

function shutdown() {
  running = false;
  console.log(pc.dim('\n  desligando...'));
  try {
    recorder?.stop();
    recorder?.release();
    porcupine?.release();
  } catch {
    // Encerrando de qualquer jeito.
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((err) => {
  console.error(pc.red(`\n${err.message}\n`));
  process.exit(1);
});
