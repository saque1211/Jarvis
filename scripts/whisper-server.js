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
// A porta tem que ser a MESMA que o STT_SERVER_URL do .env, senao o servidor
// sobe num lugar e o JARVIS procura noutro — ele diz "fora do ar" com o
// processo rodando na frente da pessoa. Por isso o .env manda aqui.
const portaDoEnv = config.voice.sttServerUrl
  ? new URL(config.voice.sttServerUrl).port
  : null;
const port = process.env.WHISPER_SERVER_PORT || portaDoEnv || '8080';

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
console.log(pc.dim(`  porta:   ${port}${portaDoEnv === port ? ' (a do seu STT_SERVER_URL)' : ''}\n`));
if (portaDoEnv && portaDoEnv !== port) {
  console.log(
    pc.yellow(`  Atencao: seu STT_SERVER_URL aponta pra porta ${portaDoEnv}, e este vai subir na ${port}.`)
  );
  console.log(pc.dim('  O JARVIS vai procurar na porta errada. Tire o WHISPER_SERVER_PORT do .env.\n'));
} else if (!portaDoEnv) {
  console.log(pc.bold('  Ponha isto no .env pro JARVIS usar o servidor:'));
  console.log(pc.green(`    STT_SERVER_URL=http://127.0.0.1:${port}\n`));
}
console.log(pc.dim('  Deixe esta janela aberta. Ctrl+C encerra.\n'));

const child = spawn(bin, ['-m', model, '-l', 'pt', '--port', port], { stdio: 'inherit' });

child.on('exit', (code) => process.exit(code ?? 0));
process.on('SIGINT', () => child.kill());
process.on('SIGTERM', () => child.kill());
