import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { run, ps, psQuote } from '../platform/win32.js';
import { config } from '../core/config.js';
import { pushAudio } from './speaker.js';

/** Mesma quebra respeitando aspas que o STT usa — caminho com espaco e comum. */
function tokenize(command) {
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  const tokens = [];
  let match;
  while ((match = re.exec(command)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

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

/**
 * A voz nativa do Windows. Zero dependencia.
 * Com `outFile`, grava em vez de tocar — e assim que a fala vai pro celular.
 */
async function speakSapi(text, outFile = null) {
  const wanted = config.voice.voiceName;

  // JARVIS_VOICE casa por pedaco do nome ("maria", "daniel") pra voce nao ter
  // que digitar "Microsoft Maria Desktop" inteiro. Sem ele, a primeira pt-BR.
  const selectVoice = wanted
    ? `$alvo = $synth.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Name -like ${psQuote(`*${wanted}*`)} } | Select-Object -First 1
if (-not $alvo) { $alvo = $synth.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -eq 'pt-BR' } | Select-Object -First 1 }`
    : `$alvo = $synth.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -eq 'pt-BR' } | Select-Object -First 1`;

  const script = `
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
${selectVoice}
if ($alvo) { $synth.SelectVoice($alvo.VoiceInfo.Name) }
$synth.Rate = ${config.voice.rate}
$synth.Volume = ${config.voice.volume}
${outFile ? `$synth.SetOutputToWaveFile(${psQuote(outFile)})` : ''}
$synth.Speak(${psQuote(text)})
$synth.Dispose()
`;
  return ps(script, { timeoutMs: 60000 });
}

/** Sintetiza pra arquivo, sem tocar em alto-falante nenhum. */
async function synthesizeToFile(text) {
  const out = path.join(os.tmpdir(), `jarvis-fala-${Date.now()}.wav`);

  if (config.voice.ttsCommand) {
    const [cmd, ...args] = tokenize(config.voice.ttsCommand).map((t) =>
      t.replace('{text}', text).replace('{out}', out)
    );
    const result = await run(cmd, args, { timeoutMs: 60000, stdin: text });
    if (!fs.existsSync(out)) throw new Error(`TTS_COMMAND nao gerou audio: ${result.stderr}`);
    return out;
  }

  await speakSapi(text, out);
  if (!fs.existsSync(out)) throw new Error('SAPI nao gerou o arquivo de audio.');
  return out;
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
    // Rede de seguranca: chamada de tool que escapou do parser nao pode virar
    // audio. O llm.js ja converte as que reconhece; isto pega o resto.
    .replace(/<(function|tool)[^>]*>[\s\S]*?<\/(function|tool)[^>]*>/gi, '')
    .replace(/<\/?(function|tool)[^>]*>/gi, '')
    .replace(/\{"[\w]+":[\s\S]*?\}/g, '')
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
    // Celular com a pagina aberta ganha a fala. Ninguem ouvindo la, toca aqui —
    // assim fechar a aba nao deixa o JARVIS mudo sem avisar.
    if (config.voice.speakerMode === 'phone') {
      const wav = await synthesizeToFile(clean);
      if (pushAudio(wav, clean)) return;
      fs.rmSync(wav, { force: true });
    }

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
