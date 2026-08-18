#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import pc from 'picocolors';
import { config } from '../src/core/config.js';
import { transcribe, sttEngineName } from '../src/voice/stt.js';
import { speak } from '../src/voice/tts.js';
import { writeWav, frameEnergy } from '../src/voice/wav.js';

/**
 * Testa microfone, transcricao e fala — sem gatilho, sem LLM, sem tools.
 *
 * O `npm run listen` junta seis coisas numa corrente so; quando ele falha, nao
 * da pra saber qual elo quebrou. Aqui cada etapa reporta sozinha.
 */

const SECONDS = Number(process.argv[2]) || 5;
const FRAME_LENGTH = 512;
const SAMPLE_RATE = 16000;

const ok = (msg) => console.log(`  ${pc.green('OK')}   ${msg}`);
const fail = (msg) => console.log(`  ${pc.red('X')}    ${msg}`);

async function main() {
  console.log(pc.bold(pc.cyan('\n  VEXIS — teste de voz\n')));

  // 1. Gravador
  let PvRecorder;
  try {
    ({ PvRecorder } = await import('@picovoice/pvrecorder-node'));
  } catch {
    fail('pvrecorder nao instalado — rode: npm install @picovoice/pvrecorder-node');
    process.exit(1);
  }

  // Lista antes de tentar abrir: quando o PvRecorder falha, saber quais
  // dispositivos existem e o que separa "sem permissao" de "indice errado".
  let devices = [];
  try {
    devices = PvRecorder.getAvailableDevices();
  } catch {
    // Segue — a mensagem do open() abaixo diz mais.
  }

  if (devices.length) {
    ok(`${devices.length} dispositivo(s) de entrada:`);
    devices.forEach((d, i) => console.log(pc.dim(`       [${i}] ${d}`)));
  } else {
    fail('nenhum dispositivo de entrada encontrado');
    console.log(pc.dim('       O Windows nao esta expondo microfone nenhum. Cheque:'));
    console.log(pc.dim('       Configuracoes > Privacidade > Microfone > "Permitir que aplicativos'));
    console.log(pc.dim('       da area de trabalho acessem o microfone" ligado.'));
    process.exit(1);
  }

  let recorder;
  try {
    recorder = new PvRecorder(FRAME_LENGTH, config.voice.micIndex);
    recorder.start();
  } catch (err) {
    fail(`nao consegui abrir o microfone: ${err.message}`);
    console.log(pc.dim(`\n       JARVIS_MIC_INDEX atual: ${config.voice.micIndex} (-1 = padrao do sistema)`));
    console.log(pc.dim('       Tente apontar um indice da lista acima no .env, por exemplo:'));
    console.log(pc.dim('         JARVIS_MIC_INDEX=0'));
    console.log(pc.dim('       Se todos falharem, e permissao de microfone do Windows.'));
    process.exit(1);
  }
  ok(`microfone aberto: ${recorder.getSelectedDevice()}`);

  // 2. Gravacao, com medidor de volume pra ver se o mic capta de verdade
  console.log(pc.bold(pc.cyan(`\n  Fale agora — gravando ${SECONDS}s...\n`)));

  const frames = [];
  const totalFrames = Math.ceil((SECONDS * SAMPLE_RATE) / FRAME_LENGTH);
  let peak = 0;

  for (let i = 0; i < totalFrames; i++) {
    const frame = await recorder.read();
    frames.push(...frame);
    const energy = frameEnergy(frame);
    peak = Math.max(peak, energy);

    if (i % 6 === 0) {
      const bars = Math.min(40, Math.round(energy * 300));
      process.stdout.write(`\r  ${pc.dim('|')}${pc.green('█'.repeat(bars))}${' '.repeat(40 - bars)}${pc.dim('|')}`);
    }
  }
  console.log('\n');

  recorder.stop();
  recorder.release();

  if (peak < 0.01) {
    fail(`pico de volume ${peak.toFixed(4)} — o microfone nao captou nada`);
    console.log(pc.dim('       Cheque se o mic certo foi escolhido (JARVIS_MIC_INDEX no .env)'));
    console.log(pc.dim('       e se o Windows deu permissao de microfone pro terminal.'));
    process.exit(1);
  }
  ok(`captou audio (pico ${peak.toFixed(3)})`);

  // 3. Transcricao
  // Guardado de proposito: quando a transcricao sai errada, e esse arquivo que
  // separa "o microfone captou mal" de "o whisper entendeu mal". Escute-o.
  const wavPath = path.join(os.tmpdir(), `jarvis-teste-${Date.now()}.wav`);
  writeWav(wavPath, Int16Array.from(frames), SAMPLE_RATE);
  ok(`WAV salvo: ${wavPath}`);

  const engine = await sttEngineName();
  if (!engine) {
    fail('nenhum motor de STT configurado');
    process.exit(1);
  }
  ok(`motor de STT: ${engine}`);

  console.log(pc.dim('\n  transcrevendo...'));
  const started = Date.now();
  let text;
  try {
    text = await transcribe(wavPath);
  } catch (err) {
    fail(err.message);
    console.log(pc.dim(`\n  O WAV ficou em ${wavPath} — teste seu comando de STT nele na mao.`));
    process.exit(1);
  }
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  if (!text) {
    fail(`transcricao vazia (${elapsed}s) — audio captado, mas o STT nao devolveu texto`);
    process.exit(1);
  }

  ok(`transcreveu em ${elapsed}s`);
  console.log(`\n  ${pc.bold('voce disse:')} ${pc.white(text)}\n`);
  console.log(pc.dim(`  Saiu errado? Escute o WAV pra saber de quem e a culpa:`));
  console.log(pc.dim(`    start ${wavPath}`));
  console.log(pc.dim('  Se o audio estiver claro, o problema e o modelo do whisper.'));
  console.log(pc.dim('  Se estiver abafado ou cortado, e o microfone.\n'));

  // Ruido do proprio motor vazando pro stdout estraga o roteamento sem avisar.
  if (/load_backend|whisper_init|ggml_|system_info/i.test(text)) {
    fail('a transcricao veio com log do motor misturado');
    console.log(pc.dim('       Adicione --no-prints ao STT_COMMAND, ou mande o log pro stderr.'));
  }

  // 4. Fala
  console.log(pc.dim('  falando de volta...'));
  try {
    await speak(`Ouvi: ${text}`);
    ok('TTS funcionou');
  } catch (err) {
    fail(`TTS falhou: ${err.message}`);
  }

  console.log(pc.bold(pc.green('\n  Cadeia de voz completa. Pode rodar npm run listen.\n')));
}

main().catch((err) => {
  console.error(pc.red(`\n  ${err.message}\n`));
  process.exit(1);
});
