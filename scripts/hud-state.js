#!/usr/bin/env node
import { snapshot } from '../src/core/state.js';
import { ensureDirs } from '../src/core/config.js';

/**
 * Imprime o snapshot que o HUD consome.
 *
 * Serve pra duas coisas: mandar dado real junto do brief de design, e conferir
 * que cada painel tem de onde tirar informacao antes de alguem desenhar.
 *
 *   npm run hud:state          JSON completo
 *   npm run hud:state -- watch atualiza a cada segundo
 */

ensureDirs();

const watch = process.argv.includes('watch');

function print() {
  if (watch) process.stdout.write('\x1Bc');
  console.log(JSON.stringify(snapshot(), null, 2));
}

print();
if (watch) setInterval(print, 1000);
