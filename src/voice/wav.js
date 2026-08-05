import fs from 'node:fs';

/**
 * Escritor de WAV PCM 16-bit mono. O Porcupine/PvRecorder entrega Int16Array
 * cru; whisper quer um arquivo com header. Sao 44 bytes — nao vale uma
 * dependencia.
 */
export function writeWav(filePath, frames, sampleRate = 16000) {
  const samples = frames instanceof Int16Array ? frames : Int16Array.from(frames);
  const dataSize = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // tamanho do bloco fmt
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits por amostra
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < samples.length; i++) {
    buffer.writeInt16LE(samples[i], 44 + i * 2);
  }

  fs.writeFileSync(filePath, buffer);
  return filePath;
}

/**
 * Energia RMS de um frame, normalizada em 0..1. Usada pra detectar silencio
 * e saber quando o usuario parou de falar.
 */
export function frameEnergy(frame) {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) {
    const sample = frame[i] / 32768;
    sum += sample * sample;
  }
  return Math.sqrt(sum / frame.length);
}
