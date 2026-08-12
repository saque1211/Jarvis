#!/usr/bin/env node
import pc from 'picocolors';
import { ps, psQuote } from '../src/platform/win32.js';
import { config } from '../src/core/config.js';

/**
 * Lista as vozes do Windows e fala uma frase com cada uma, pra voce escolher
 * ouvindo em vez de adivinhar pelo nome.
 */

const FRASE = 'Oi, eu sou o Jarvis. Posso falar com esta voz.';

const result = await ps(`
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.GetInstalledVoices() | ForEach-Object { "$($_.VoiceInfo.Name)|$($_.VoiceInfo.Culture.Name)|$($_.VoiceInfo.Gender)" }
`);

const vozes = (result.stdout || '')
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => {
    const [name, culture, gender] = l.split('|');
    return { name, culture, gender };
  });

if (!vozes.length) {
  console.error(pc.red('\n  Nenhuma voz SAPI encontrada. Isto so funciona no Windows.\n'));
  process.exit(1);
}

console.log(pc.bold(pc.cyan('\n  Vozes instaladas\n')));

const atual = config.voice.voiceName;
for (const voz of vozes) {
  const emUso = atual && voz.name.toLowerCase().includes(atual.toLowerCase());
  const marca = emUso ? pc.green(' ← em uso') : '';
  console.log(`  ${pc.bold(voz.name)} ${pc.dim(`[${voz.culture}, ${voz.gender}]`)}${marca}`);
}

const ouvir = !process.argv.includes('--mudo');
if (ouvir) {
  console.log(pc.dim('\n  Falando com cada uma... (--mudo pula esta parte)\n'));
  for (const voz of vozes) {
    console.log(pc.dim(`  ♪ ${voz.name}`));
    await ps(`
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.SelectVoice(${psQuote(voz.name)})
$synth.Rate = ${config.voice.rate}
$synth.Speak(${psQuote(FRASE)})
$synth.Dispose()
`, { timeoutMs: 30000 });
  }
}

console.log(pc.bold('\n  Pra usar uma delas, ponha no .env um pedaco do nome:'));
console.log(pc.green(`    JARVIS_VOICE=${vozes[0].name.split(' ')[1] || vozes[0].name}\n`));
console.log(pc.dim('  Tambem da pra ajustar JARVIS_VOICE_RATE (-10 a 10) e'));
console.log(pc.dim('  JARVIS_VOICE_VOLUME (0 a 100).\n'));
console.log(pc.dim('  Poucas vozes em pt-BR? O Windows tem mais pra instalar em'));
console.log(pc.dim('  Configuracoes > Hora e idioma > Voz > Adicionar vozes.\n'));
console.log(pc.dim('  Quer voz bem melhor que o SAPI? Veja Piper no .skills/voice.md.\n'));
