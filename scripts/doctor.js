#!/usr/bin/env node
import fs from 'node:fs';
import pc from 'picocolors';
import { config } from '../src/core/config.js';
import { loadSkills, buildToolIndex, skillsDeOutraPlataforma } from '../src/core/registry.js';
import { sttEngineName, promptDeVocabulario, nomesDeApps, limparPrompt } from '../src/voice/stt.js';
import { resolverSom } from '../src/skills/timer.js';
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
  if (result.code === -1) return false;

  const saida = `${result.stdout} ${result.stderr}`;

  // O Windows 11 poe um atalho falso de "python" que so abre a Microsoft Store.
  // Ele executa, entao o teste de "existe?" passava e o doctor dava OK num
  // Python que nao existe.
  if (/was not found|Microsoft Store|execution alias/i.test(saida)) return false;

  // Exit 0 ou algo com cara de versao. Alguns CLIs saem com codigo != 0 no
  // --version mas imprimem a versao do mesmo jeito.
  return result.code === 0 || /\d+\.\d+/.test(saida);
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

    // Fora do Windows a contagem cai de 17 pra 6, e sem explicar isso parece
    // que as skills sumiram. Elas existem — e a maquina que nao serve pra elas.
    const doWindows = await skillsDeOutraPlataforma('win32');
    if (doWindows.length && process.platform !== 'win32') {
      const nTools = doWindows.reduce((n, s) => n + s.tools.length, 0);
      warn(`+${doWindows.length} skills (${nTools} tools) so rodam no Windows: ${doWindows.map((s) => s.name).join(', ')}`);
      console.log(pc.dim('       Elas controlam a maquina local. Na nuvem, quem as roda e o agente do PC.'));
    }
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
        // Fora do ar so e falha quando nao ha comando local pra assumir.
        const aviso = config.voice.sttCommand ? warn : fail;
        aviso(`  whisper-server nao esta no ar em ${config.voice.sttServerUrl}`);
        if (config.voice.sttCommand) {
          // Alarme falso se o listen nao esta rodando: quem sobe o servidor e
          // o daemon, e o doctor roda sozinho. Dizer isso evita a pessoa sair
          // atras de um problema que nao existe.
          console.log(pc.dim('       Normal se o "npm run listen" nao esta rodando — quem sobe'));
          console.log(pc.dim('       o servidor e ele. Confira a linha [whisper] quando subir.'));
          console.log(pc.dim('       Se estiver fora do ar COM o listen rodando, ai sim tem algo'));
          console.log(pc.dim('       errado: cada frase custa ~2s a mais recarregando o modelo.'));
          console.log(pc.dim('       Nesse caso suba na mao: npm run whisper:server'));
        } else {
          console.log(pc.dim('       Suba num terminal separado: npm run whisper:server'));
          console.log(pc.dim('       Ou configure STT_COMMAND como reserva.'));
        }
      }
    }
    // O vocabulario e o que decide entre "vesse code" e "VS Code". Mostrar o
    // texto real evita descobrir tarde que ele esta vazio ou com lixo colado.
    const vocab = promptDeVocabulario();
    // Quantos apps EXISTEM e quantos couberam sao numeros diferentes: o prompt
    // tem teto, e entrada de instalador nao entra. Mostrar so o primeiro faz
    // parecer que tudo foi mandado.
    const noPrompt = (vocab.match(/Aplicativos: (.*?)\./) || [, ''])[1].split(', ').filter(Boolean);
    const total = nomesDeApps().length;
    const comandosInteiros = vocab.trimEnd().endsWith('projeto.');
    ok(
      `  vocabulario: ${vocab.length} caracteres — ${noPrompt.length} de ${total} apps` +
        `, comandos ${comandosInteiros ? 'completos' : 'CORTADOS'}`
    );
    console.log(pc.dim(`       "${vocab.slice(0, 110)}..."`));
    if (!comandosInteiros) {
      console.log(pc.dim('       O prompt bateu no teto. Palavras como "pomodoro" e "screenshot"'));
      console.log(pc.dim('       ficaram de fora — o whisper vai errar mais nelas.'));
    }
    if (config.voice.sttPrompt && limparPrompt(config.voice.sttPrompt) !== config.voice.sttPrompt.trim()) {
      warn('  seu STT_PROMPT tinha linha de comando colada — cortei o pedaco');
      console.log(pc.dim('       Vale limpar a linha no .env pra nao confundir depois.'));
    }

    // STT_COMMAND ser lido nao garante que o executavel e o modelo existem —
    // e o erro so apareceria na primeira frase falada. Vale checar tambem
    // quando ele e so a reserva do servidor: com o servidor fora do ar, e ele
    // que transcreve TODO comando, e ninguem olhou pra ele.
    if (stt === 'STT_COMMAND' || config.voice.sttCommand) {
      const parts = config.voice.sttCommand.match(/"([^"]*)"|(\S+)/g) || [];
      const paths = parts
        .map((p) => p.replace(/"/g, ''))
        .filter((p) => /[/\\]/.test(p) && !p.includes('{file}'));
      const rotulo = stt === 'STT_COMMAND' ? '' : ' (reserva do servidor)';
      for (const p of paths) {
        if (fs.existsSync(p)) ok(`  existe${rotulo}: ${p}`);
        else fail(`  NAO existe: ${p} — o STT vai falhar na primeira frase`);
      }

      // Qual modelo esta em uso e a pergunta que mais importa pra precisao, e
      // ela estava invisivel: o nome do .bin so aparecia dentro do comando.
      const bin = paths.find((p) => /\.bin$/i.test(p));
      const tamanho = bin && fs.existsSync(bin) ? fs.statSync(bin).size / 1e6 : 0;
      if (tamanho) {
        const nome = /tiny/i.test(bin)
          ? 'tiny'
          : /base/i.test(bin)
            ? 'base'
            : /small/i.test(bin)
              ? 'small'
              : /medium/i.test(bin)
                ? 'medium'
                : /large/i.test(bin)
                  ? 'large'
                  : '?';
        const linha = `  modelo do whisper: ${nome} (${Math.round(tamanho)} MB)`;
        if (nome === 'tiny' || nome === 'base') {
          warn(`${linha} — erra nome proprio em portugues`);
          console.log(pc.dim('       Melhore com: npm run whisper:model small'));
        } else ok(linha);
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

  if (config.edgeTts.voice) {
    ok(`TTS: Edge (${config.edgeTts.voice}) — gratuito, precisa de internet`);
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

  // Som configurado e som que TOCA sao coisas diferentes: nome errado, arquivo
  // faltando ou chave lida do lugar errado caem no beep em silencio. Sem esta
  // linha, so um timer vencendo revelaria — e ai a pessoa culpa o .env.
  const somDoTimer = config.voice.timerSound;
  if (somDoTimer.toLowerCase() === 'off') ok('alarme do timer: silencioso (so a notificacao)');
  else if (somDoTimer.toLowerCase() === 'beep') ok('alarme do timer: beep do console');
  else {
    const arquivo = resolverSom(somDoTimer);
    if (arquivo) ok(`alarme do timer: ${somDoTimer} → ${arquivo}`);
    else {
      warn(`alarme do timer: "${somDoTimer}" nao existe — vai tocar o beep`);
      console.log(pc.dim('       Veja os nomes validos com: npm run sons -- --so-lista'));
    }
  }

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
