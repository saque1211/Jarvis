import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

/**
 * Fala na nuvem, com Piper.
 *
 * A versao Windows chamava o Piper por PowerShell; aqui e Linux e o binario e
 * chamado direto. Mesmo motor, mesma voz — o que muda e so quem executa.
 *
 * A sintese fica no servidor em vez de no Pi de proposito: o Pi Zero 2 W leva
 * varios segundos pra sintetizar uma frase, e o servidor leva milissegundos.
 * O Pi so recebe bytes e toca.
 */

const BINARIO = process.env.PIPER_BIN || 'piper';
const VOZ = process.env.PIPER_VOICE || '/opt/piper/pt_BR-faber-medium.onnx';

export function ttsConfigurado() {
  return fs.existsSync(VOZ);
}

/**
 * Sintetiza e devolve o WAV. Devolve null quando o Piper nao esta instalado —
 * o servidor entao responde so texto, e quem chamou decide o que fazer. Um
 * assistente que responde por escrito e pior que um que fala, mas e muito
 * melhor que um que da erro.
 */
export async function sintetizar(texto) {
  if (!texto?.trim()) return null;
  if (!ttsConfigurado()) return null;

  const saida = path.join(os.tmpdir(), `jarvis-${Date.now()}.wav`);

  try {
    await new Promise((resolve, reject) => {
      const p = spawn(BINARIO, ['--model', VOZ, '--output_file', saida], {
        stdio: ['pipe', 'ignore', 'pipe'],
      });
      let erro = '';
      p.stderr.on('data', (d) => (erro += d));
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(erro.slice(0, 200)))));

      // O Piper le o texto do stdin: nada de montar linha de comando com o que
      // veio do usuario.
      p.stdin.write(texto);
      p.stdin.end();
    });

    const wav = fs.readFileSync(saida);
    return wav;
  } catch {
    return null;
  } finally {
    fs.rmSync(saida, { force: true });
  }
}
