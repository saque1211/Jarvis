#!/usr/bin/env node
import pc from 'picocolors';
import { psJson } from '../src/platform/win32.js';
import { tocarAlarme } from '../src/skills/timer.js';
import { config } from '../src/core/config.js';

/**
 * Lista e toca os sons que o Windows ja traz, pra escolher o do timer de
 * ouvido em vez de pelo nome do arquivo. "Alarm03" nao diz nada; ouvir diz.
 *
 *   npm run sons              toca todos, um por um
 *   npm run sons alarm        so os que casam com "alarm"
 *   npm run sons -- --so-lista  lista sem tocar
 */

const PASTA = 'C:/Windows/Media';

async function main() {
  const args = process.argv.slice(2);
  const soLista = args.includes('--so-lista');
  const filtro = args.find((a) => !a.startsWith('--'))?.toLowerCase();

  console.log(pc.bold(pc.cyan('\n  Sons do Windows — pro alarme do timer\n')));
  console.log(pc.dim(`  atual: JARVIS_TIMER_SOM=${config.voice.timerSound}\n`));

  const { ok, data, error } = await psJson(
    `Get-ChildItem -Path '${PASTA}' -Filter *.wav -ErrorAction SilentlyContinue |
       Select-Object -ExpandProperty BaseName`
  );
  if (!ok) {
    console.error(pc.red(`  nao consegui ler ${PASTA}: ${error}\n`));
    process.exit(1);
  }

  const todos = (Array.isArray(data) ? data : data ? [data] : []).sort();
  const nomes = filtro ? todos.filter((n) => n.toLowerCase().includes(filtro)) : todos;

  if (!nomes.length) {
    console.log(pc.yellow(`  nada encontrado${filtro ? ` para "${filtro}"` : ''}.\n`));
    return;
  }

  if (soLista) {
    for (const n of nomes) console.log(`    ${n}`);
    console.log();
    return;
  }

  console.log(pc.dim(`  ${nomes.length} som(ns). Ctrl+C pra parar.\n`));
  for (const nome of nomes) {
    console.log(`    ${pc.bold(nome)}`);
    await tocarAlarme(nome);
    await new Promise((r) => setTimeout(r, 250));
  }

  console.log(pc.bold('\n  Escolheu? Ponha no .env:\n'));
  console.log(pc.cyan("    Add-Content .env 'JARVIS_TIMER_SOM=Alarm03'"));
  console.log(pc.dim('\n  Vale tambem "beep" (o padrao), "off" (silencioso) ou'));
  console.log(pc.dim('  o caminho de um .wav seu.\n'));
}

main().catch((err) => {
  console.error(pc.red(`\n  falhou: ${err.message}\n`));
  process.exit(1);
});
