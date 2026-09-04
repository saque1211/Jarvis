#!/usr/bin/env node
import os from 'node:os';
import pc from 'picocolors';
import { startNucleus } from '../src/cloud/nucleus.js';

/**
 * Sobe o nucleus — a porta de entrada com contas.
 *
 * Diferente do HUD (aberto, pra rede de casa), o nucleus exige login: serve as
 * mesmas paginas e delega o mesmo cerebro, mas por cima poe entrar, criar conta
 * e parear aparelho. Roda na porta 3000 — a mesma que o HUD e o app checam pra
 * saber que estao "na nuvem" e pedir login.
 *
 *   npm run nucleus        sobe o servidor de contas
 *
 * Pra valer na internet, ele mora num VPS atras de HTTPS. Local, serve pra
 * testar o fluxo de login e pareamento igualzinho.
 */

const PORTA = Number(process.env.JARVIS_NUCLEUS_PORT || 3000);

function ipDaRede() {
  for (const nics of Object.values(os.networkInterfaces())) {
    for (const nic of nics || []) {
      if (nic.family === 'IPv4' && !nic.internal) return nic.address;
    }
  }
  return null;
}

async function main() {
  const nucleus = startNucleus({ port: PORTA });
  const ip = ipDaRede();

  console.log(pc.bold(pc.cyan('\n  VEXIS — nucleus (contas)\n')));
  console.log(`  ${pc.green('no ar')}  http://127.0.0.1:${PORTA}`);
  if (ip) {
    console.log(pc.dim(`  HUD:      http://${ip}:${PORTA}/`));
    console.log(pc.dim(`  app:      http://${ip}:${PORTA}/app`));
  }
  console.log(pc.dim('\n  Toda rota de dado exige login. Abra o /app pra criar conta.'));
  console.log(pc.dim('  Ctrl+C encerra.\n'));

  const encerrar = () => {
    nucleus.stop();
    process.exit(0);
  };
  process.on('SIGINT', encerrar);
  process.on('SIGTERM', encerrar);
}

main().catch((err) => {
  console.error(pc.red(`\n  falhou: ${err.message}\n`));
  process.exit(1);
});
