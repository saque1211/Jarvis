import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { run, ps, psQuote } from '../platform/win32.js';
import { config } from '../core/config.js';
import { pushAudio } from './speaker.js';
import { synthesize as fishSynthesize, isConfigured as fishConfigured } from '../integrations/fish-audio.js';
import { synthesize as edgeSynthesize, isConfigured as edgeConfigured } from '../integrations/edge-tts.js';

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

/** Sintetiza pra arquivo com o TTS local, sem tocar em alto-falante nenhum. */
async function synthesizeLocal(text) {
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

  // Quebra respeitando aspas: "C:/Program Files/piper/piper.exe" e um argumento
  // so. Com split(' ') o executavel nunca era encontrado.
  const [cmd, ...args] = tokenize(config.voice.ttsCommand).map((t) =>
    t.replace('{text}', text).replace('{out}', out)
  );
  const result = await run(cmd, args, { timeoutMs: 60000, stdin: text });

  if (!result.ok && !fs.existsSync(out)) {
    throw new Error(`TTS_COMMAND falhou: ${result.stderr || 'executavel nao encontrado'}`);
  }

  await playWav(out);
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
    // Voz na nuvem depende de rede e de credito. Se falhar, a fala tem que
    // sair do mesmo jeito — mudo por causa de API fora do ar seria pior que
    // uma voz feia.
    for (const [nome, configurado, sintetizar] of [
      ['Fish Audio', fishConfigured, fishSynthesize],
      ['Edge', edgeConfigured, edgeSynthesize],
    ]) {
      if (!configurado()) continue;
      try {
        const wav = await sintetizar(clean);
        if (config.voice.speakerMode === 'phone' && pushAudio(wav, clean)) return;
        await playWav(wav);
        return;
      } catch (err) {
        console.error(`[tts] ${nome} falhou, tentando a proxima voz: ${err.message}`);
      }
    }

    // Celular com a pagina aberta ganha a fala. Ninguem ouvindo la, toca aqui —
    // assim fechar a aba nao deixa o JARVIS mudo sem avisar.
    if (config.voice.speakerMode === 'phone') {
      const wav = await synthesizeLocal(clean);
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

/**
 * Toca um arquivo de audio sem abrir player nenhum, e apaga depois.
 *
 * SoundPlayer so entende WAV. Como TTS externo costuma cuspir MP3, o formato e
 * detectado pelo conteudo — extensao mente, os primeiros bytes nao.
 */
async function playWav(file) {
  try {
    const cabecalho = Buffer.alloc(4);
    const fd = fs.openSync(file, 'r');
    fs.readSync(fd, cabecalho, 0, 4, 0);
    fs.closeSync(fd);

    const script =
      cabecalho.toString('ascii') === 'RIFF'
        ? `(New-Object System.Media.SoundPlayer ${psQuote(file)}).PlaySync()`
        : // MediaPlayer toca MP3, mas abre de forma assincrona: sem esperar a
          // duracao aparecer, o Play() sai antes do audio comecar.
          `Add-Type -AssemblyName PresentationCore
$p = New-Object System.Windows.Media.MediaPlayer
$p.Open([System.Uri]::new(${psQuote(file)}))
$limite = (Get-Date).AddSeconds(10)
while (-not $p.NaturalDuration.HasTimeSpan -and (Get-Date) -lt $limite) { Start-Sleep -Milliseconds 50 }
$p.Play()
if ($p.NaturalDuration.HasTimeSpan) {
  Start-Sleep -Milliseconds ($p.NaturalDuration.TimeSpan.TotalMilliseconds + 300)
}
$p.Close()`;

    await ps(script, { timeoutMs: 60000 });
  } finally {
    fs.rmSync(file, { force: true });
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
