#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pc from 'picocolors';
import { listarVozes, cota, sintetizarBytes } from '../src/integrations/elevenlabs.js';
import { config } from '../src/core/config.js';
import { playWav } from '../src/voice/tts.js';

/**
 * Lista as vozes do ElevenLabs e fala uma frase com cada uma.
 *
 * O ID da voz e um hash: escolher pelo site e colar no .env funciona, mas ouvir
 * em portugues e no seu alto-falante e outra coisa — voz que soa bem no demo
 * deles pode soar mal na sua caixa de som.
 *
 *   npm run voices:eleven                 lista
 *   npm run voices:eleven -- --ouvir      fala uma frase com cada
 *   npm run voices:eleven -- --ouvir rachel   so as que casam com o nome
 */

const FRASE =
  process.env.ELEVENLABS_FRASE ||
  'Abri o Spotify e coloquei o modo foco. A GPU esta em sessenta e um por cento.';

async function main() {
  console.log(pc.bold(pc.cyan('\n  VEXIS — vozes do ElevenLabs\n')));

  if (!config.elevenLabs.apiKey) {
    console.log(`  ${pc.red('X')}  Falta ELEVENLABS_API_KEY no .env.\n`);
    console.log(pc.dim('     Crie a chave em elevenlabs.io → Profile → API Keys'));
    console.log(pc.dim('     Depois: Add-Content .env \'ELEVENLABS_API_KEY=sua-chave\'\n'));
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const ouvir = args.includes('--ouvir');
  const filtro = args.find((a) => !a.startsWith('--'))?.toLowerCase();

  const c = await cota();
  if (c) {
    const restante = c.limite - c.usados;
    const cor = restante < c.limite * 0.1 ? pc.red : pc.dim;
    console.log(
      cor(`  plano ${c.plano} · ${c.usados.toLocaleString('pt-BR')} de ` +
          `${c.limite.toLocaleString('pt-BR')} caracteres usados este mes\n`)
    );
  }

  let vozes;
  try {
    vozes = await listarVozes();
  } catch (err) {
    console.log(`  ${pc.red('X')}  ${err.message}\n`);
    process.exit(1);
  }

  const lista = filtro
    ? vozes.filter((v) => `${v.nome} ${v.descricao}`.toLowerCase().includes(filtro))
    : vozes;

  if (!lista.length) {
    console.log(pc.yellow(`  Nenhuma voz${filtro ? ` para "${filtro}"` : ''}.\n`));
    return;
  }

  const atual = config.elevenLabs.voiceId;
  for (const v of lista) {
    const marca = v.id === atual ? pc.green('→') : ' ';
    console.log(`  ${marca} ${pc.bold(v.nome.padEnd(18))} ${pc.dim(v.id)}`);
    if (v.descricao) console.log(pc.dim(`      ${v.descricao}`));

    if (ouvir) {
      // Falar custa caracteres da cota — por isso so com --ouvir.
      const arquivo = path.join(os.tmpdir(), `vexis-voz-${v.id}.mp3`);
      try {
        // Sintetiza com ESTA voz, nao com a do .env: o objetivo e comparar.
        const antes = config.elevenLabs.voiceId;
        config.elevenLabs.voiceId = v.id;
        const bytes = await sintetizarBytes(FRASE);
        config.elevenLabs.voiceId = antes;

        fs.writeFileSync(arquivo, bytes);
        await playWav(arquivo);
      } catch (err) {
        console.log(pc.yellow(`      nao consegui ouvir: ${err.message}`));
      } finally {
        fs.rmSync(arquivo, { force: true });
      }
    }
  }

  console.log(pc.bold('\n  Escolheu? Ponha no .env:\n'));
  console.log(pc.cyan("    Add-Content .env 'ELEVENLABS_VOICE_ID=o-id-acima'"));
  console.log(pc.dim('\n  Ouvir gasta cota: cada frase de teste conta como caracteres.'));
  console.log(pc.dim('  Por isso a lista sozinha nao fala nada — use --ouvir quando quiser.\n'));
}

main().catch((err) => {
  console.error(pc.red(`\n  falhou: ${err.message}\n`));
  process.exit(1);
});
