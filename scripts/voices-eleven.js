#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pc from 'picocolors';
import { listarVozes, cota, sintetizarBytes, parecerIdDeVoz } from '../src/integrations/elevenlabs.js';
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

  // Pega o erro antes da rede: ID de voz no lugar da chave e o engano mais
  // comum, porque os dois codigos vem do mesmo site.
  if (parecerIdDeVoz(config.elevenLabs.apiKey)) {
    console.log(`  ${pc.red('X')}  O valor em ELEVENLABS_API_KEY parece um ID de VOZ, nao uma chave.\n`);
    console.log(pc.dim('     ID de voz  = exatamente 20 caracteres, vem da pagina da voz'));
    console.log(pc.dim('     Chave      = 32 hexadecimais (formato antigo) ou "sk_" com 51'));
    console.log(pc.dim('                  caracteres (atual) — os dois valem\n'));
    console.log('     Conserto:');
    console.log(pc.cyan(`       Add-Content .env 'ELEVENLABS_VOICE_ID=${config.elevenLabs.apiKey}'`));
    console.log(pc.cyan("       Add-Content .env 'ELEVENLABS_API_KEY=sk_a-chave-de-verdade'\n"));
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
    console.log(`  ${pc.yellow('--')}  ${err.message}\n`);

    // Nao condena a chave sem testar o que realmente importa. Listar vozes e
    // conveniencia; falar e a funcao. Uma chave restrita a text-to-speech
    // falha na primeira e funciona na segunda.
    if (err.talvezRestrita) {
      console.log(pc.dim('     Testando se ela pelo menos FALA...'));
      try {
        const bytes = await sintetizarBytes('Teste.');
        console.log(`  ${pc.green('OK')}  a chave sintetiza (${bytes.length} bytes) — ela serve pro VEXIS.\n`);
        console.log('     A voz atual continua valendo. Pra trocar de voz, pegue o ID');
        console.log('     na pagina da voz em elevenlabs.io e ponha em ELEVENLABS_VOICE_ID,');
        console.log('     ou crie uma chave com permissao de leitura pra listar por aqui.\n');
        return;
      } catch (e2) {
        // Cota estourada prova que a chave AUTENTICOU: o erro veio depois do
        // portao. Dizer "e nao sintetiza tambem" logo abaixo de "pode estar
        // revogada" faz as duas linhas somarem "sua chave e ruim", que e o
        // oposto do que os dois erros juntos significam.
        const semCota = /[Cc]ota/.test(e2.message);
        if (semCota) {
          console.log(`  ${pc.green('OK')}  a chave e VALIDA — ela passou pela autenticacao.`);
          console.log(`  ${pc.yellow('--')}  ${e2.message}`);
          console.log(pc.dim('\n     Assine em elevenlabs.io/app/subscription. Ate la o VEXIS'));
          console.log(pc.dim('     continua falando: a voz cai pro provedor seguinte sozinha.\n'));
        } else {
          console.log(`  ${pc.red('X')}  e nao sintetiza tambem: ${e2.message}\n`);
        }
      }
    }
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
