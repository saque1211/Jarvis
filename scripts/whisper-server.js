#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import pc from 'picocolors';
import { config } from '../src/core/config.js';

/**
 * Sobe o whisper-server do whisper.cpp com o modelo que voce ja configurou.
 *
 * Existe porque o whisper-cli recarrega o modelo inteiro a cada comando —
 * centenas de MB do disco pra transcrever tres segundos de fala. O servidor
 * carrega uma vez e fica de pe.
 *
 * Ele deduz binario e modelo do seu STT_COMMAND, entao voce nao configura a
 * mesma coisa duas vezes.
 */

function guessFromSttCommand() {
  const command = config.voice.sttCommand;
  if (!command) return {};

  const tokens = (command.match(/"([^"]*)"|(\S+)/g) || []).map((t) => t.replace(/"/g, ''));
  const model = tokens[tokens.indexOf('-m') + 1] || tokens[tokens.indexOf('--model') + 1];
  const cli = tokens.find((t) => /whisper-cli(\.exe)?$/i.test(t));
  const bin = cli ? cli.replace(/whisper-cli(\.exe)?$/i, 'whisper-server$1') : null;

  return { bin, model };
}

const guessed = guessFromSttCommand();
const bin = process.env.WHISPER_SERVER_BIN || guessed.bin;
const model = process.env.WHISPER_MODEL_PATH || guessed.model;
const port = process.env.WHISPER_SERVER_PORT || '8080';

if (!bin || !model) {
  console.error(
    pc.red('\n  Nao consegui deduzir o whisper-server a partir do STT_COMMAND.\n') +
      pc.dim('  Aponte na mao no .env:\n') +
      pc.dim('    WHISPER_SERVER_BIN=C:/whisper/whisper-server.exe\n') +
      pc.dim('    WHISPER_MODEL_PATH=C:/whisper/ggml-small.bin\n')
  );
  process.exit(1);
}

for (const [label, file] of [['binario', bin], ['modelo', model]]) {
  if (!fs.existsSync(file)) {
    console.error(pc.red(`\n  ${label} nao existe: ${file}\n`));
    process.exit(1);
  }
}

console.log(pc.bold(pc.cyan('\n  whisper-server')));
console.log(pc.dim(`  binario: ${bin}`));
console.log(pc.dim(`  modelo:  ${path.basename(model)}`));
console.log(pc.dim(`  porta:   ${port}\n`));
console.log(pc.bold('  Ponha isto no .env pro JARVIS usar o servidor:'));
console.log(pc.green(`    STT_SERVER_URL=http://127.0.0.1:${port}\n`));
console.log(pc.dim('  Deixe esta janela aberta. Ctrl+C encerra.\n'));

const child = spawn(bin, ['-m', model, '-l', 'pt', '--port', port], { stdio: 'inherit' });

child.on('exit', (code) => process.exit(code ?? 0));
process.on('SIGINT', () => child.kill());
process.on('SIGTERM', () => child.kill());
