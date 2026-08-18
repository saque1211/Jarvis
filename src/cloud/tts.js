import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { sintetizarBytes, isConfigured as elevenConfigured } from '../integrations/elevenlabs.js';

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
  return elevenConfigured() || fs.existsSync(VOZ);
}

/** Qual voz o servidor vai usar, pro banner nao mentir. */
export function motorDeVoz() {
  if (elevenConfigured()) return 'ElevenLabs';
  if (fs.existsSync(VOZ)) return 'Piper';
  return null;
}

/**
 * Sintetiza e devolve o WAV. Devolve null quando o Piper nao esta instalado —
 * o servidor entao responde so texto, e quem chamou decide o que fazer. Um
 * assistente que responde por escrito e pior que um que fala, mas e muito
 * melhor que um que da erro.
 */
export async function sintetizar(texto) {
  if (!texto?.trim()) return null;

  // ElevenLabs primeiro. Falhando — cota do mes, rede, chave — o Piper assume:
  // o Pi ficar mudo e pior que ele falar com voz pior.
  if (elevenConfigured()) {
    try {
      return await sintetizarBytes(texto);
    } catch (err) {
      console.error(`[tts] ElevenLabs falhou, caindo pro Piper: ${err.message}`);
    }
  }

  if (!fs.existsSync(VOZ)) return null;

  const saida = path.join(os.tmpdir(), `vexis-${Date.now()}.wav`);

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
