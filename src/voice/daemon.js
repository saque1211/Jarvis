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
import { startSpeaker, stopSpeaker, lanAddress, listenerCount } from './speaker.js';
import { ensureWhisperServer, stopWhisperServer } from './whisper-server.js';
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

// Deteccao de fim de fala. O limiar e relativo ao proprio microfone: um numero
// fixo funciona num mic silencioso e falha num ruidoso, onde o chiado sozinho
// ja fica acima dele — e ai o daemon nunca acusa silencio, grava ate o limite
// de tempo, e entrega ao whisper a frase afogada em ruido.
const SILENCE_FLOOR = 0.006; // piso absoluto, pra mic muito limpo
const NOISE_MARGIN = 2.5; // quantas vezes o chiado medido conta como fala
const SPEECH_RATIO = 0.12; // fracao do pico que ainda conta como fala
// Teto: o limiar nunca pode passar disso do pico. Sem ele, uma gravacao que
// comeca ja com voz tem "chiado" igual a propria voz, o limiar vai a 2,5x a
// fala, nada nunca conta como fala — e a captura so termina no tempo maximo.
const SPEECH_CAP = 0.5;

let trigger = null;
let recorder = null;
let running = true;
let lastLevels = null;

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
  // Piso: antes disso nenhum silencio encerra. A pausa que todo mundo faz
  // depois das duas primeiras palavras nao pode ser lida como fim de frase.
  const minFrames = Math.ceil(config.voice.minCommandMs / frameMs);

  let silentRun = 0;
  let spoke = false;
  let peak = 0;
  // Piso de ruido: o menor nivel visto ate agora. Toda gravacao tem pausa
  // entre palavras, entao esse minimo converge pro chiado do microfone.
  let floor = Infinity;

  for (let i = 0; i < maxFrames; i++) {
    const frame = await recorder.read();
    frames.push(...frame);

    // Soltar a tecla e um fim exato — a pessoa disse que acabou. Vale mais que
    // qualquer heuristica de silencio, entao corta na hora.
    if (spoke && trigger.endedByRelease?.()) break;

    const energy = frameEnergy(frame);
    peak = Math.max(peak, energy);
    floor = Math.min(floor, energy);

    // Limiar relativo ao proprio microfone, nao um numero fixo. Com um mic
    // ruidoso, um limiar fixo baixo nunca acusa silencio: o daemon grava os 15
    // segundos inteiros e o whisper recebe a frase afogada em chiado.
    const threshold = Math.min(
      peak * SPEECH_CAP,
      Math.max(SILENCE_FLOOR, floor * NOISE_MARGIN, peak * SPEECH_RATIO)
    );

    if (config.voice.vadDebug && i % 8 === 0) {
      process.stdout.write(
        `\r  ${pc.dim(
          `t=${((i * frameMs) / 1000).toFixed(1)}s energia=${energy.toFixed(4)} ` +
            `limiar=${threshold.toFixed(4)} chiado=${(floor === Infinity ? 0 : floor).toFixed(4)} ` +
            `silencio=${((silentRun * frameMs) / 1000).toFixed(1)}s   `
        )}`
      );
    }

    if (energy > threshold) {
      spoke = true;
      silentRun = 0;
    } else if (spoke) {
      // So conta silencio depois que a pessoa comecou a falar; senao a gente
      // corta antes de ela abrir a boca.
      silentRun++;
      if (silentRun >= silenceFramesNeeded && i >= minFrames) break;
    } else if (i > silenceFramesNeeded * 3) {
      // Gatilho disparou mas ninguem falou nada: aborta.
      return null;
    }
  }

  if (!spoke) return null;

  lastLevels = { peak, floor: floor === Infinity ? 0 : floor };
  return Int16Array.from(frames);
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

  // Da pra sentir lentidao em quatro lugares diferentes aqui, e so medindo pra
  // saber qual. O silencio de fim de fala e tempo morto puro: ja acabou de
  // falar, e o daemon ainda esta esperando pra ter certeza.
  const heard = audio.length / SAMPLE_RATE;
  const t0 = Date.now();

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

  const sttMs = Date.now() - t0;
  log('voce', pc.white(text), pc.green);
  writeRuntime({ lastTranscript: text });

  try {
    const { reply, steps, timings } = await route(text, {
      source: 'voice',
      onStep: ({ tool }) => log('tool', pc.yellow(tool), pc.yellow),
    });
    log('jarvis', pc.white(reply), pc.magenta);
    if (steps.some((s) => !s.ok)) {
      log('aviso', pc.yellow(`${steps.filter((s) => !s.ok).length} tool(s) falharam`), pc.yellow);
    }

    const s = (ms) => `${(ms / 1000).toFixed(1)}s`;
    log(
      'tempo',
      `${s(sttMs)} transcricao · ${s(timings.total)} resposta ` +
        pc.dim(`(${heard.toFixed(1)}s de fala, ${s(config.voice.silenceMs)} de silencio esperado)`)
    );

    // Pico contra chiado: quando essa distancia e curta, nenhum modelo salva a
    // transcricao — o problema esta no microfone, nao no whisper.
    if (lastLevels) {
      const { peak, floor } = lastLevels;
      const ratio = floor > 0 ? peak / floor : Infinity;
      const veredito =
        ratio < 8 ? pc.yellow(' — fala perto do ruido, transcricao vai sofrer') : '';
      log('audio', pc.dim(`pico ${peak.toFixed(3)} · chiado ${floor.toFixed(3)}`) + veredito);
    }

    writeRuntime({ voiceState: 'speaking', speakerListeners: listenerCount() });
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

  const servidor = await ensureWhisperServer();
  if (servidor) log('whisper', servidor);
  log('tts', config.voice.ttsCommand ? 'TTS_COMMAND' : 'SAPI (voz nativa do Windows)');

  if (config.voice.speakerMode === 'phone') {
    const port = config.voice.speakerPort;
    try {
      await startSpeaker(port);
      const url = `http://${lanAddress()}:${port}`;
      log('alto-falante', pc.green(url), pc.green);
      console.log(pc.dim(`  Abra esse endereco no navegador do celular e toque em "Tocar aqui".`));
      console.log(pc.dim('  Sem ninguem com a pagina aberta, a fala volta pro PC.\n'));
    } catch (err) {
      log('alto-falante', pc.red(`nao subiu na porta ${port}: ${err.message}`), pc.red);
      log('alto-falante', 'a fala continua saindo pelo PC');
    }
  }
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
    stopSpeaker();
    stopWhisperServer();
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
