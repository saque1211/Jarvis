import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { run, ps, psQuote } from '../platform/win32.js';
import { config } from '../core/config.js';
import { pushAudio } from './speaker.js';
import { synthesize as elevenSynthesize, isConfigured as elevenConfigured } from '../integrations/elevenlabs.js';
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
 *
 * Devolve quanto cada etapa custou. Quem chama pode ignorar; o daemon usa pra
 * separar "a nuvem demorou pra sintetizar" de "o Windows demorou pra tocar".
 * Sao dois problemas com solucoes opostas — e os dois somam no mesmo silencio,
 * entao medir a fala inteira num numero so nao aponta nada.
 */
export async function speak(text) {
  const medida = { provedor: null, sinteseMs: 0, playerMs: 0 };

  if (!text || !config.voice.speakReplies) return medida;
  if (speaking) return medida;

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

  if (!clean) return medida;

  speaking = true;
  try {
    // Voz na nuvem depende de rede e de credito. Se falhar, a fala tem que
    // sair do mesmo jeito — mudo por causa de API fora do ar seria pior que
    // uma voz feia.
    for (const [nome, configurado, sintetizar] of [
      // Ordem = preferencia. O ElevenLabs vem primeiro por ser o melhor; se a
      // cota do mes acabar, os de baixo assumem sem ninguem perceber.
      ['ElevenLabs', elevenConfigured, elevenSynthesize],
      ['Fish Audio', fishConfigured, fishSynthesize],
      ['Edge', edgeConfigured, edgeSynthesize],
    ]) {
      if (!configurado()) continue;
      try {
        const t = Date.now();
        const wav = await sintetizar(clean);
        medida.provedor = nome;
        medida.sinteseMs = Date.now() - t;

        if (config.voice.speakerMode === 'phone' && pushAudio(wav, clean)) return medida;

        const tp = Date.now();
        await playWav(wav);
        medida.playerMs = Date.now() - tp;
        return medida;
      } catch (err) {
        console.error(`[tts] ${nome} falhou, tentando a proxima voz: ${err.message}`);
        // Zera: o tempo de um provedor que falhou nao pode aparecer como se
        // fosse o custo do que acabou falando.
        medida.provedor = null;
        medida.sinteseMs = 0;
      }
    }

    // Celular com a pagina aberta ganha a fala. Ninguem ouvindo la, toca aqui —
    // assim fechar a aba nao deixa o JARVIS mudo sem avisar.
    if (config.voice.speakerMode === 'phone') {
      const wav = await synthesizeLocal(clean);
      if (pushAudio(wav, clean)) return medida;
      fs.rmSync(wav, { force: true });
    }

    // Nos locais a sintese e a reproducao sao a mesma chamada: nao da pra
    // separar, entao entra tudo como sintese em vez de inventar uma divisao.
    const t = Date.now();
    medida.provedor = config.voice.ttsCommand ? 'TTS_COMMAND' : 'SAPI';
    if (config.voice.ttsCommand) await speakCommand(clean);
    else await speakSapi(clean);
    medida.sinteseMs = Date.now() - t;
  } catch (err) {
    console.error(`[tts] ${err.message}`);
  } finally {
    speaking = false;
  }

  return medida;
}

/**
 * Toca um arquivo de audio sem abrir player nenhum, e apaga depois.
 *
 * SoundPlayer so entende WAV. Como TTS externo costuma cuspir MP3, o formato e
 * detectado pelo conteudo — extensao mente, os primeiros bytes nao.
 */
/**
 * Toca um arquivo de audio. Exportado porque os scripts de audicao de voz
 * precisam tocar sem passar pela cadeia inteira do `speak`.
 */
export async function playWav(file) {
  try {
    const cabecalho = Buffer.alloc(4);
    const fd = fs.openSync(file, 'r');
    fs.readSync(fd, cabecalho, 0, 4, 0);
    fs.closeSync(fd);

    const script =
      cabecalho.toString('ascii') === 'RIFF'
        ? `(New-Object System.Media.SoundPlayer ${psQuote(file)}).PlaySync()`
        : // MediaPlayer toca MP3, mas abre de forma assincrona: o Play() volta
          // antes do audio acabar, entao o script precisa segurar o processo
          // pela duracao da midia.
          //
          // Play() vem ANTES de saber a duracao: a versao anterior esperava o
          // Open() terminar pra so entao comecar o audio, e esse tempo de
          // abertura virava silencio na frente da fala. Depois desconta o que
          // ja passou, senao ele entra duas vezes na conta.
          `Add-Type -AssemblyName PresentationCore
$p = New-Object System.Windows.Media.MediaPlayer
$p.Open([System.Uri]::new(${psQuote(file)}))
$p.Play()
$t0 = Get-Date
$limite = $t0.AddSeconds(10)
while (-not $p.NaturalDuration.HasTimeSpan -and (Get-Date) -lt $limite) { Start-Sleep -Milliseconds 20 }
if ($p.NaturalDuration.HasTimeSpan) {
  $decorrido = ((Get-Date) - $t0).TotalMilliseconds
  $resta = $p.NaturalDuration.TimeSpan.TotalMilliseconds - $decorrido + 150
  if ($resta -gt 0) { Start-Sleep -Milliseconds ([int]$resta) }
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
