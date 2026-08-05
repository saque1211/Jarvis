import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { run, ps, psQuote } from '../platform/win32.js';
import { config } from '../core/config.js';

/**
 * Sintese de voz.
 *
 * Padrao: SAPI, a voz nativa do Windows. Nao e a mais bonita, mas ja esta
 * instalada e fala pt-BR (voz Maria) — o JARVIS responde no primeiro boot,
 * sem baixar nada.
 *
 * Upgrade: Piper, local e bem melhor. Configure TTS_COMMAND no .env com
 * {text} e {out} como placeholders.
 */

let speaking = false;

/** A voz nativa do Windows. Zero dependencia. */
async function speakSapi(text) {
  const script = `
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
# Prefere uma voz pt-BR se houver; senao usa a padrao do sistema.
$ptbr = $synth.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -eq 'pt-BR' } | Select-Object -First 1
if ($ptbr) { $synth.SelectVoice($ptbr.VoiceInfo.Name) }
$synth.Rate = 1
$synth.Speak(${psQuote(text)})
$synth.Dispose()
`;
  return ps(script, { timeoutMs: 60000 });
}

/** Piper ou qualquer outro TTS via linha de comando. */
async function speakCommand(text) {
  const out = path.join(os.tmpdir(), `jarvis-tts-${Date.now()}.wav`);
  const filled = config.voice.ttsCommand
    .replace('{text}', text.replace(/"/g, ''))
    .replace('{out}', out);

  const [cmd, ...args] = filled.split(' ');
  const result = await run(cmd, args, { timeoutMs: 60000, stdin: text });

  if (!result.ok && !fs.existsSync(out)) {
    throw new Error(`TTS_COMMAND falhou: ${result.stderr}`);
  }

  // Toca o wav gerado sem abrir player nenhum.
  await ps(`(New-Object System.Media.SoundPlayer ${psQuote(out)}).PlaySync()`, { timeoutMs: 60000 });
  fs.rmSync(out, { force: true });
  return { ok: true };
}

/**
 * Fala um texto. Serializa as chamadas: duas falas ao mesmo tempo viram ruido.
 */
export async function speak(text) {
  if (!text || !config.voice.speakReplies) return;
  if (speaking) return;

  // Markdown e emoji viram lixo sonoro na sintese.
  const clean = String(text)
    .replace(/[*_`#>]/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'link')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 800);

  if (!clean) return;

  speaking = true;
  try {
    if (config.voice.ttsCommand) await speakCommand(clean);
    else await speakSapi(clean);
  } catch (err) {
    console.error(`[tts] ${err.message}`);
  } finally {
    speaking = false;
  }
}

/** Lista as vozes SAPI disponiveis — util no doctor. */
export async function listVoices() {
  const result = await ps(`
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.GetInstalledVoices() | ForEach-Object { "$($_.VoiceInfo.Name) [$($_.VoiceInfo.Culture.Name)]" }
`);
  return result.stdout || '(nenhuma)';
}
