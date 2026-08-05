#!/usr/bin/env node
import readline from 'node:readline';
import pc from 'picocolors';
import { config, ensureDirs } from './core/config.js';
import { route } from './core/router.js';
import { speak } from './voice/tts.js';
import { loadSkills } from './core/registry.js';

/**
 * Interface de texto. Mesmo roteador que a voz usa — o que funciona aqui
 * funciona falado, e testar por texto e muito mais rapido.
 */

const BANNER = `
${pc.bold(pc.cyan('  JARVIS'))}
${pc.dim('  SPEAK. ROUTE. REMEMBER. REPEAT.')}
`;

async function runOnce(command, { spoken }) {
  const { reply, steps, timings } = await route(command, {
    source: 'cli',
    onNote: (note) => console.log(pc.dim(`  · ${note}`)),
    onStep: ({ tool }) => console.log(pc.dim(`  → ${tool}`)),
  });

  console.log(`\n${pc.magenta('JARVIS:')} ${reply}\n`);

  if (timings) {
    const s = (ms) => `${(ms / 1000).toFixed(1)}s`;
    console.log(
      pc.dim(
        `  ${s(timings.total)} total — ${s(timings.preselect)} escolha, ` +
          `${s(timings.llm)} modelo, ${s(timings.tools)} máquina\n`
      )
    );
  }

  const failed = steps.filter((s) => !s.ok);
  if (failed.length) {
    for (const step of failed) console.log(pc.yellow(`  ! ${step.tool}: ${step.error}`));
    console.log();
  }

  if (spoken) await speak(reply);
  return reply;
}

async function repl() {
  console.log(BANNER);
  console.log(pc.dim('  Digite um comando, ou "sair" pra encerrar.'));
  console.log(pc.dim('  "skills" lista tudo que eu sei fazer.\n'));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = () =>
    new Promise((resolve) => rl.question(pc.green('você: '), (answer) => resolve(answer.trim())));

  while (true) {
    const input = await ask();
    if (!input) continue;
    if (['sair', 'exit', 'quit', 'tchau'].includes(input.toLowerCase())) break;

    if (input.toLowerCase() === 'skills') {
      const skills = await loadSkills();
      for (const skill of skills) {
        console.log(`\n${pc.bold(pc.cyan(skill.name))} — ${skill.description}`);
        for (const tool of skill.tools) console.log(pc.dim(`  ${tool.name}`));
      }
      console.log();
      continue;
    }

    try {
      await runOnce(input, { spoken: config.voice.speakReplies });
    } catch (err) {
      console.error(pc.red(`\n  ${err.message}\n`));
    }
  }

  rl.close();
  console.log(pc.dim('\n  até mais.\n'));
}

async function main() {
  ensureDirs();
  const args = process.argv.slice(2);

  const noSpeak = args.includes('--mudo');
  const command = args.filter((a) => !a.startsWith('--')).join(' ');

  if (!command) {
    await repl();
    return;
  }

  await runOnce(command, { spoken: config.voice.speakReplies && !noSpeak });
}

main().catch((err) => {
  console.error(pc.red(`\n  ${err.message}\n`));
  process.exit(1);
});
