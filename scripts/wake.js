#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pc from 'picocolors';
import { config } from '../src/core/config.js';
import { casaWake, fonetizar, distancia } from '../src/voice/wake.js';
import { pedacoDeFala } from '../src/voice/trigger.js';
import { transcribe } from '../src/voice/stt.js';
import { writeWav } from '../src/voice/wav.js';
import { ensureWhisperServer } from '../src/voice/whisper-server.js';

/**
 * Calibrar a palavra de ativacao.
 *
 * "Deixa bem sensivel" nao e um numero que da pra escolher no escuro: depende
 * do seu microfone, do seu comodo e de como VOCE fala o nome. Este script
 * mostra as duas coisas que faltam pra decidir — o que o Whisper ouviu, e
 * quao longe aquilo ficou do alvo.
 *
 *   npm run wake                 escuta de verdade, ao vivo
 *   npm run wake -- "vexes"      testa frases sem microfone nenhum
 */

const SAMPLE_RATE = 16000;
const FRAME_LENGTH = 512;

function veredito(texto) {
  const r = casaWake(texto);
  const alvo = fonetizar(config.voice.wakeWord);
  const chave = fonetizar(texto.split(/\s+/)[0] || '');
  const d = r.casou ? r.distancia : distancia(chave, alvo);

  if (r.casou) {
    return (
      pc.green('  ACORDA  ') +
      pc.dim(`distancia ${d} (limite ${config.voice.wakeTolerancia})`) +
      (r.sobra ? pc.cyan(`  → comando: "${r.sobra}"`) : '')
    );
  }
  return pc.dim('  ignora  ') + pc.dim(`distancia ${d} (limite ${config.voice.wakeTolerancia})`);
}

function cabecalho() {
  console.log(pc.bold(pc.cyan('\n  VEXIS — calibragem da palavra de ativacao\n')));
  console.log(`  nome      ${pc.bold(config.voice.wakeWord)}  ${pc.dim(`(som: ${fonetizar(config.voice.wakeWord)})`)}`);
  console.log(`  tolerancia ${config.voice.wakeTolerancia}  ${pc.dim('VEXIS_WAKE_TOLERANCIA no .env')}`);
  if (config.voice.wakeAliases.length) {
    console.log(`  aliases   ${config.voice.wakeAliases.join(', ')}`);
  }
  console.log();
}

/** Modo sem microfone: voce digita as frases, ele julga. */
function modoTexto(frases) {
  cabecalho();
  for (const f of frases) {
    console.log(`  ${JSON.stringify(f).padEnd(34)}${veredito(f)}`);
  }
  console.log();
}

/** Modo ao vivo: fala e ve. E o unico jeito de saber se esta sensivel o bastante. */
async function modoAoVivo() {
  cabecalho();

  if (!config.voice.sttServerUrl) {
    console.log(pc.yellow('  Sem STT_SERVER_URL no .env — cada pedaco recarregaria o modelo'));
    console.log(pc.yellow('  do disco e a calibragem ficaria lenta demais pra dizer algo.\n'));
  }

  const servidor = await ensureWhisperServer((p) => console.log(pc.dim(`  [whisper] ${p}`)));
  if (servidor) console.log(pc.dim(`  [whisper] ${servidor}`));

  let PvRecorder;
  try {
    ({ PvRecorder } = await import('@picovoice/pvrecorder-node'));
  } catch {
    console.log(pc.red('\n  Falta o pacote de gravacao: npm install @picovoice/pvrecorder-node\n'));
    process.exit(1);
  }

  const recorder = new PvRecorder(FRAME_LENGTH, config.voice.micIndex);
  recorder.start();
  console.log(pc.dim(`  mic: ${recorder.getSelectedDevice()}`));
  console.log(pc.bold(pc.cyan(`\n  Fale. Diga "${config.voice.wakeWord}" de varios jeitos.`)));
  console.log(pc.dim('  Ctrl+C pra sair.\n'));

  let acordou = 0;
  let total = 0;

  const sair = () => {
    recorder.stop();
    recorder.release();
    console.log(pc.dim(`\n  ${acordou} de ${total} pedacos acordariam o VEXIS.\n`));
    if (total && acordou === 0) {
      console.log(pc.yellow('  Nenhum acordou. Suba VEXIS_WAKE_TOLERANCIA pra 3, ou ponha em'));
      console.log(pc.yellow('  VEXIS_WAKE_ALIASES exatamente as grafias que apareceram acima.\n'));
    }
    process.exit(0);
  };
  process.on('SIGINT', sair);

  while (true) {
    const pedaco = await pedacoDeFala(recorder, FRAME_LENGTH);
    if (!pedaco) continue;

    const arquivo = path.join(os.tmpdir(), `vexis-calibra-${Date.now()}.wav`);
    let texto;
    try {
      writeWav(arquivo, pedaco.audio, SAMPLE_RATE);
      texto = await transcribe(arquivo);
    } catch (err) {
      console.log(pc.red(`  erro: ${err.message}`));
      continue;
    } finally {
      fs.rmSync(arquivo, { force: true });
    }

    if (!texto) continue;
    total++;
    const r = casaWake(texto);
    if (r.casou) acordou++;
    const seg = (pedaco.audio.length / SAMPLE_RATE).toFixed(1);
    const corte = pedaco.truncado ? pc.yellow(' [cortado no teto]') : '';
    console.log(`  ${pc.dim(`${seg}s`)}  ${JSON.stringify(texto).padEnd(34)}${veredito(texto)}${corte}`);
  }
}

const args = process.argv.slice(2);
if (args.length) modoTexto(args);
else await modoAoVivo();
