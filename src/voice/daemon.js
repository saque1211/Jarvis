#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import pc from 'picocolors';
import { config, ensureDirs } from '../core/config.js';
import { route } from '../core/router.js';
import { transcribe, sttEngineName } from './stt.js';
import { speak } from './tts.js';
import { createTrigger } from './trigger.js';
import { writeWav, frameEnergy } from './wav.js';
import { checkDueReminders } from '../skills/notify.js';
import { checkDueTimers } from '../skills/timer.js';
import { writeRuntime } from '../core/state.js';

/**
 * Daemon de voz: espera o gatilho, grava o comando ate voce parar de falar,
 * transcreve local, roteia pro modelo e responde em voz alta.
 *
 * O gatilho e trocavel (wake word, tecla de atalho ou Enter) — veja
 * `trigger.js`. O daemon so pergunta "ja posso escutar?" e nao liga pra quem
 * respondeu.
 *
 * O loop tambem dispara os lembretes vencidos — assim nao existe um segundo
 * processo agendador pra manter vivo.
 */

const SAMPLE_RATE = 16000;
const SILENCE_THRESHOLD = 0.012; // RMS abaixo disso conta como silencio

let trigger = null;
let recorder = null;
let running = true;

function log(label, message, color = pc.dim) {
  console.log(`${color(`[${label}]`)} ${message}`);
}

async function loadRecorder() {
  try {
    const { PvRecorder } = await import('@picovoice/pvrecorder-node');
    return PvRecorder;
  } catch {
    throw new Error(
      'Pacote de gravacao nao instalado. Rode:\n' +
        '  npm install @picovoice/pvrecorder-node\n' +
        '(Esse nao precisa de chave nenhuma — so a wake word precisa.)'
    );
  }
}

/**
 * Grava depois do gatilho ate detectar silencio sustentado ou estourar o
 * tempo maximo. Devolve os frames concatenados.
 */
async function captureCommand() {
  const frames = [];
  const frameMs = (trigger.frameLength / SAMPLE_RATE) * 1000;
  const silenceFramesNeeded = Math.ceil(config.voice.silenceMs / frameMs);
  const maxFrames = Math.ceil(config.voice.maxCommandMs / frameMs);

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
      // Gatilho disparou mas ninguem falou nada: aborta.
      return null;
    }
  }

  return spoke ? Int16Array.from(frames) : null;
}

async function handleUtterance() {
  log('escuta', pc.cyan('pode falar'), pc.cyan);
  writeRuntime({ voiceState: 'listening' });

  const audio = await captureCommand();
  if (!audio) {
    log('escuta', 'nao ouvi nada, voltando a dormir');
    writeRuntime({ voiceState: 'idle' });
    return;
  }

  writeRuntime({ voiceState: 'thinking' });

  const wavPath = path.join(os.tmpdir(), `jarvis-${Date.now()}.wav`);
  writeWav(wavPath, audio, SAMPLE_RATE);

  let text;
  try {
    text = await transcribe(wavPath);
  } catch (err) {
    log('stt', pc.red(err.message), pc.red);
    writeRuntime({ voiceState: 'idle' });
    await speak('Nao consegui transcrever. Confira a configuracao do STT.');
    return;
  } finally {
    fs.rmSync(wavPath, { force: true });
  }

  if (!text || text.length < 2) {
    log('stt', 'transcricao vazia');
    writeRuntime({ voiceState: 'idle' });
    return;
  }

  log('voce', pc.white(text), pc.green);
  writeRuntime({ lastTranscript: text });

  try {
    const { reply, steps } = await route(text, {
      source: 'voice',
      onStep: ({ tool }) => log('tool', pc.yellow(tool), pc.yellow),
    });
    log('jarvis', pc.white(reply), pc.magenta);
    if (steps.some((s) => !s.ok)) {
      log('aviso', pc.yellow(`${steps.filter((s) => !s.ok).length} tool(s) falharam`), pc.yellow);
    }
    writeRuntime({ voiceState: 'speaking' });
    await speak(reply);
  } catch (err) {
    log('erro', pc.red(err.message), pc.red);
    await speak('Deu erro aqui. Confira o terminal.');
  } finally {
    writeRuntime({ voiceState: 'idle' });
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

  const PvRecorder = await loadRecorder();
  trigger = await createTrigger();
  log('gatilho', trigger.kind);

  try {
    recorder = new PvRecorder(trigger.frameLength, config.voice.micIndex);
  } catch (err) {
    throw new Error(
      `Nao consegui abrir o microfone: ${err.message}\n` +
        'Rode "npm run test:voice" — ele lista os dispositivos disponiveis e diz\n' +
        'se e permissao do Windows ou JARVIS_MIC_INDEX errado.'
    );
  }
  // So a wake word precisa do microfone aberto sem parar. Com tecla de atalho
  // o mic abre no disparo e fecha depois — nada de buffer velho na captura, e
  // o indicador do Windows so acende quando voce pediu.
  if (trigger.needsAudio) recorder.start();

  log('mic', pc.green(recorder.getSelectedDevice()), pc.green);
  console.log(pc.bold(pc.cyan(`\n  ${trigger.label}\n`)));

  writeRuntime({
    voiceState: 'idle',
    sttEngine: engine,
    micDevice: recorder.getSelectedDevice(),
    trigger: trigger.kind,
  });

  // Lembretes: precisao de meio minuto basta.
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

  // Timers: precisam do segundo exato, entao rodam num tick proprio.
  const countdownTimer = setInterval(async () => {
    try {
      const fired = await checkDueTimers();
      for (const timer of fired) {
        log('timer', pc.yellow(timer.message), pc.yellow);
        await speak(timer.message);
      }
    } catch {
      // Idem: nao derruba a escuta.
    }
  }, 1000);

  while (running) {
    await trigger.wait(recorder);
    if (!running) break;

    if (!trigger.needsAudio) recorder.start();
    try {
      await handleUtterance();
    } finally {
      if (!trigger.needsAudio) recorder.stop();
    }

    console.log(pc.dim(`\n  ${trigger.label}\n`));
  }

  clearInterval(reminderTimer);
  clearInterval(countdownTimer);
}

function shutdown() {
  running = false;
  console.log(pc.dim('\n  desligando...'));
  try {
    writeRuntime({ voiceState: 'offline' });
  } catch {
    // Encerrando de qualquer jeito.
  }
  try {
    recorder?.stop();
    recorder?.release();
    trigger?.release();
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
