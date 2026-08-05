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
  if (config.anthropicApiKey) ok(`ANTHROPIC_API_KEY presente, modelo ${config.model}`);
  else fail('ANTHROPIC_API_KEY ausente — sem isso o JARVIS nao roteia nada');

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
  if (config.voice.picovoiceKey) ok('PICOVOICE_ACCESS_KEY presente (wake word)');
  else fail('PICOVOICE_ACCESS_KEY ausente — pegue gratis em console.picovoice.ai');

  try {
    await import('@picovoice/porcupine-node');
    await import('@picovoice/pvrecorder-node');
    ok('pacotes de wake word instalados');
  } catch {
    fail('rode: npm install @picovoice/porcupine-node @picovoice/pvrecorder-node');
  }

  const stt = await sttEngineName();
  if (stt) ok(`STT: ${stt}`);
  else fail('nenhum motor de STT — instale whisper.cpp ou openai-whisper');

  if (config.voice.ttsCommand) ok('TTS: comando customizado configurado');
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
