#!/usr/bin/env node
import os from 'node:os';
import crypto from 'node:crypto';
import pc from 'picocolors';
import { startCloud } from '../src/cloud/server.js';
import { motorDeVoz } from '../src/cloud/tts.js';
import { loadSkills, toolSpecs } from '../src/core/registry.js';
import { config } from '../src/core/config.js';

/**
 * Sobe o JARVIS na nuvem. E o processo que fica no VPS.
 *
 *   npm run cloud
 */

const PORTA = Number(process.env.PORT || process.env.JARVIS_CLOUD_PORT || 8080);

async function main() {
  console.log(pc.bold(pc.cyan('\n  VEXIS — nuvem\n')));

  const problemas = [];
  if (!process.env.JARVIS_CLOUD_TOKEN) {
    problemas.push([
      'JARVIS_CLOUD_TOKEN ausente — o servidor recusaria tudo.',
      `Gere um: JARVIS_CLOUD_TOKEN=${crypto.randomBytes(24).toString('base64url')}`,
    ]);
  }
  if (!process.env.GROQ_API_KEY) {
    problemas.push([
      'GROQ_API_KEY ausente — sem ela nao ha transcricao (o Pi vira mudo).',
      'A do Whisper e gratuita: console.groq.com/keys',
    ]);
  }
  if (!config.llm.apiKey) {
    problemas.push([`${config.llm.keyName} ausente — sem cerebro nao ha resposta.`, '']);
  }

  if (problemas.length) {
    for (const [erro, dica] of problemas) {
      console.log(`  ${pc.red('X')}  ${erro}`);
      if (dica) console.log(pc.dim(`     ${dica}`));
    }
    console.log();
    process.exit(1);
  }

  const skills = await loadSkills();
  const tools = toolSpecs(skills);

  console.log(`  provedor   ${config.llm.provider} · ${config.llm.model}`);
  console.log(`  transcricao Groq Whisper (nuvem)`);
  const motor = motorDeVoz();
  console.log(`  fala       ${motor || pc.yellow('nenhuma voz configurada — responde so por texto')}`);
  console.log(`  skills     ${skills.length} (${tools.length} tools) — ${skills.map((s) => s.name).join(', ')}`);
  console.log(
    pc.dim(`\n  As tools de Windows nao entram aqui: elas controlam uma maquina`)
  );
  console.log(pc.dim(`  que este servidor nao tem. Elas voltam com o agente do PC.`));

  startCloud({ port: PORTA });
  console.log(`\n  ${pc.green('no ar')}  porta ${PORTA}`);
  console.log(pc.dim(`  saude: curl http://localhost:${PORTA}/saude\n`));
}

main().catch((err) => {
  console.error(pc.red(`\n  falhou: ${err.message}\n`));
  process.exit(1);
});
