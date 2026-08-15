#!/usr/bin/env node
import os from 'node:os';
import pc from 'picocolors';
import { startHud } from '../src/hud/server.js';
import { startBackground } from '../src/platform/win32.js';

/**
 * Abre o HUD como aplicativo.
 *
 * "App" aqui e uma janela do navegador em modo --app: sem barra de endereco,
 * sem abas, com icone proprio na barra de tarefas. Parece um programa e nao
 * custa os 200 MB de runtime que um Electron empacotaria — o navegador ja
 * esta instalado.
 *
 *   npm run hud            abre a janela
 *   npm run hud -- --sem-janela   so sobe o servidor (pra abrir no celular)
 */

const PORTA = Number(process.env.JARVIS_HUD_PORT || 8791);

// Ordem de preferencia: Chrome, Edge, Brave. Todos aceitam --app.
const NAVEGADORES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
];

function ipDaRede() {
  for (const nics of Object.values(os.networkInterfaces())) {
    for (const nic of nics || []) {
      if (nic.family === 'IPv4' && !nic.internal) return nic.address;
    }
  }
  return null;
}

async function main() {
  const semJanela = process.argv.includes('--sem-janela');
  const hud = startHud({ port: PORTA });
  const url = `http://127.0.0.1:${PORTA}`;

  console.log(pc.bold(pc.cyan('\n  JARVIS — HUD\n')));
  console.log(`  ${pc.green('no ar')}  ${url}`);
  const ip = ipDaRede();
  if (ip) console.log(pc.dim(`  celular: http://${ip}:${PORTA}`));

  if (!semJanela) {
    const fs = await import('node:fs');
    const navegador = NAVEGADORES.find((c) => fs.existsSync(c));
    if (navegador) {
      // --app tira barra de endereco e abas; o user-data-dir separado evita
      // herdar a sessao do navegador normal e abrir com as abas de ontem.
      startBackground(navegador, [
        `--app=${url}`,
        '--window-size=1280,800',
        `--user-data-dir=${os.tmpdir()}/jarvis-hud`,
      ]);
      console.log(pc.dim(`  janela: ${navegador.split('/').pop()}`));
    } else {
      console.log(pc.yellow('  Nenhum Chrome/Edge/Brave encontrado — abra o endereco acima no navegador.'));
    }
  }

  console.log(pc.dim('\n  O HUD le o mesmo estado que o daemon escreve. Rode o'));
  console.log(pc.dim('  npm run listen em outro terminal pra ver a voz mexendo aqui.'));
  console.log(pc.dim('  Ctrl+C encerra.\n'));

  const encerrar = () => {
    hud.stop();
    process.exit(0);
  };
  process.on('SIGINT', encerrar);
  process.on('SIGTERM', encerrar);
}

main().catch((err) => {
  console.error(pc.red(`\n  falhou: ${err.message}\n`));
  process.exit(1);
});
