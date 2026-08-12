#!/usr/bin/env node
import fs from 'node:fs';
import pc from 'picocolors';
import { config } from '../src/core/config.js';
import { loadSkills, buildToolIndex } from '../src/core/registry.js';
import { sttEngineName } from '../src/voice/stt.js';
import { run } from '../src/platform/win32.js';
import { isConfigured as spotifyReady } from '../src/integrations/spotify.js';

/**
 * Diagnostico: diz exatamente o que ja funciona e o que falta configurar,
 * pra voce nao descobrir no meio de um comando falado.
 */

const ok = (msg) => console.log(`  ${pc.green('OK')}   ${msg}`);
const warn = (msg) => console.log(`  ${pc.yellow('--')}   ${msg}`);
const fail = (msg) => console.log(`  ${pc.red('X')}    ${msg}`);

async function hasBinary(name) {
  const result = await run(name, ['--version'], { timeoutMs: 6000 });
  return result.code !== -1;
}

async function main() {
  console.log(pc.bold(pc.cyan('\n  JARVIS — diagnostico\n')));

  console.log(pc.bold('  Plataforma'));
  if (process.platform === 'win32') ok('Windows detectado');
  else fail(`${process.platform} — as skills de sistema so funcionam no Windows`);
  ok(`Node ${process.version}`);

  console.log(pc.bold('\n  Cerebro'));
  const { provider, keyName, apiKey, model } = config.llm;
  if (apiKey) ok(`provedor ${provider}, ${keyName} presente, modelo ${model}`);
  else fail(`${keyName} ausente (provedor ${provider}) — sem isso o JARVIS nao roteia nada`);
  if (provider === 'groq') {
    warn('Groq e free tier: mais barato, mas erra mais na escolha entre 99 tools');
  }

  console.log(pc.bold('\n  Skills'));
  try {
    const skills = await loadSkills();
    const index = buildToolIndex(skills);
    ok(`${skills.length} skills carregadas, ${index.size} tools disponiveis`);
    for (const skill of skills) {
      console.log(pc.dim(`       ${skill.name.padEnd(14)} ${skill.tools.length} tools`));
    }
  } catch (err) {
    fail(`Falha ao carregar skills: ${err.message}`);
  }

  console.log(pc.bold('\n  Voz'));

  const trigger = config.voice.trigger;
  if (trigger === 'wakeword') {
    ok(`gatilho: wake word ("${config.voice.wakeWord}")`);
    if (config.voice.picovoiceKey) ok('PICOVOICE_ACCESS_KEY presente');
    else fail('PICOVOICE_ACCESS_KEY ausente — ou use JARVIS_TRIGGER=hotkey, sem chave');
    try {
      await import('@picovoice/porcupine-node');
      ok('pacote da wake word instalado');
    } catch {
      fail('rode: npm install @picovoice/porcupine-node');
    }
  } else if (trigger === 'hotkey') {
    ok(`gatilho: tecla ${config.voice.hotkey} (sem chave, funciona em segundo plano)`);
    if (process.platform !== 'win32') fail('a tecla global depende do Windows');
  } else if (trigger === 'enter') {
    ok('gatilho: Enter no terminal (sem chave, terminal precisa estar em foco)');
  } else {
    fail(`JARVIS_TRIGGER="${trigger}" nao existe — use wakeword, hotkey ou enter`);
  }

  try {
    const { PvRecorder } = await import('@picovoice/pvrecorder-node');
    const devices = PvRecorder.getAvailableDevices();
    if (devices.length) ok(`microfone: ${devices.length} dispositivo(s) — ${devices[0]}`);
    else fail('nenhum microfone detectado — cheque a permissao de microfone do Windows');
  } catch {
    fail('rode: npm install @picovoice/pvrecorder-node (esse nao precisa de chave)');
  }

  const stt = await sttEngineName();
  if (stt) {
    ok(`STT: ${stt}`);
    if (stt === 'whisper-server') {
      // Configurado nao e o mesmo que no ar — e a diferenca so apareceria na
      // primeira frase falada.
      try {
        const res = await fetch(config.voice.sttServerUrl, { signal: AbortSignal.timeout(3000) });
        ok(`  whisper-server respondendo em ${config.voice.sttServerUrl} (${res.status})`);
      } catch {
        fail(`  whisper-server NAO responde em ${config.voice.sttServerUrl}`);
        console.log(pc.dim('       Suba num terminal separado: npm run whisper:server'));
      }
    }
    // STT_COMMAND ser lido nao garante que o executavel e o modelo existem —
    // e o erro so apareceria na primeira frase falada.
    if (stt === 'STT_COMMAND') {
      const parts = config.voice.sttCommand.match(/"([^"]*)"|(\S+)/g) || [];
      const paths = parts
        .map((p) => p.replace(/"/g, ''))
        .filter((p) => /[/\\]/.test(p) && !p.includes('{file}'));
      for (const p of paths) {
        if (fs.existsSync(p)) ok(`  existe: ${p}`);
        else fail(`  NAO existe: ${p} — o STT vai falhar na primeira frase`);
      }
    }
  } else {
    fail('nenhum motor de STT');
    if (!config.voice.sttCommand) {
      console.log(pc.dim('       STT_COMMAND nao esta no .env, e nem whisper-cli nem whisper'));
      console.log(pc.dim('       foram achados no PATH. Aponte o seu no .env, por exemplo:'));
      console.log(
        pc.dim('         STT_COMMAND=C:/whisper/whisper-cli.exe -m C:/whisper/ggml-small.bin -f {file} -l pt -nt --no-prints')
      );
    }
  }

  if (config.voice.speakerMode === 'phone') {
    const { lanAddress } = await import('../src/voice/speaker.js');
    ok(`alto-falante: celular — http://${lanAddress()}:${config.voice.speakerPort}`);
    console.log(pc.dim('       (o endereco so existe com o npm run listen rodando)'));
  }

  if (config.fishAudio.apiKey && config.fishAudio.voiceId) {
    ok(`TTS: Fish Audio (voz ${config.fishAudio.voiceId.slice(0, 8)}…, modelo ${config.fishAudio.model})`);
    console.log(pc.dim('       cai no TTS local se a API falhar'));
  } else if (config.fishAudio.apiKey || config.fishAudio.voiceId) {
    fail('Fish Audio pela metade — precisa de FISH_AUDIO_API_KEY e FISH_AUDIO_VOICE_ID');
  }

  if (config.voice.ttsCommand) {
    ok('TTS: comando customizado configurado');
    // Mesma armadilha do STT: configurado nao e o mesmo que existente, e a
    // diferenca so apareceria na primeira fala.
    const partes = config.voice.ttsCommand.match(/"([^"]*)"|(\S+)/g) || [];
    for (const p of partes.map((x) => x.replace(/"/g, ''))) {
      if (!/[/\\]/.test(p) || p.includes('{out}') || p.includes('{text}')) continue;
      if (fs.existsSync(p)) ok(`  existe: ${p}`);
      else fail(`  NAO existe: ${p} — a fala vai falhar e cair no SAPI`);
    }
  }
  else if (process.platform === 'win32') ok('TTS: SAPI (voz nativa do Windows)');
  else warn('TTS: SAPI indisponivel fora do Windows');

  console.log(pc.bold('\n  Ferramentas externas'));
  for (const [bin, why] of [
    ['git', 'skill build/deploy'],
    ['ffmpeg', 'gravacao de tela com controle'],
    ['adb', 'controle do Quest 3S'],
    ['nvidia-smi', 'monitoramento de GPU'],
    ['python', 'skill exec (scripts Python)'],
  ]) {
    if (await hasBinary(bin)) ok(`${bin} — ${why}`);
    else warn(`${bin} ausente — ${why} fica indisponivel`);
  }

  console.log(pc.bold('\n  Integracoes'));
  if (spotifyReady()) ok('Spotify autorizado');
  else if (config.spotify.clientId) warn('Spotify: falta autorizar — rode npm run auth:spotify');
  else warn('Spotify: falta SPOTIFY_CLIENT_ID no .env');

  if (config.github.token) ok('GitHub token presente');
  else warn('GITHUB_TOKEN ausente — Actions e busca de codigo ficam limitados');

  if (config.discord.webhookUrl) ok('Discord webhook configurado');
  else warn('DISCORD_WEBHOOK_URL ausente');

  if (config.homeAssistant.baseUrl && config.homeAssistant.token) ok('Home Assistant configurado');
  else warn('Home Assistant ausente — controle da casa desligado');

  if (config.brave.apiKey) ok('Brave Search configurado');
  else warn('BRAVE_API_KEY ausente — busca web cai no DuckDuckGo (mais fraco)');

  if (config.freelance.feeds.length) ok(`${config.freelance.feeds.length} feed(s) de freelance`);
  else warn('FREELANCE_FEEDS vazio');

  console.log(pc.bold('\n  Vault'));
  if (fs.existsSync(config.vaultPath)) ok(config.vaultPath);
  else warn(`${config.vaultPath} sera criado no primeiro uso`);

  console.log();
}

main().catch((err) => {
  console.error(pc.red(err.stack));
  process.exit(1);
});
