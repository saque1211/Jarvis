#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import pc from 'picocolors';
import { run } from '../src/platform/win32.js';

/**
 * Baixa um modelo do whisper.cpp e imprime a linha do .env.
 *
 * O modelo e a alavanca que mais muda a transcricao — mas o custo dele nao e o
 * download, e a RAM que fica ocupada e o tempo de espera depois que voce solta
 * a tecla. Por isso este script olha a memoria livre antes de recomendar, em
 * vez de mandar todo mundo pro "large" e a maquina engasgar.
 *
 *   npm run whisper:model            recomenda pelo que a maquina aguenta
 *   npm run whisper:model small      baixa esse
 */

const DEST = process.env.WHISPER_DIR || 'C:/whisper';

// Os modelos ja moraram em mais de um repositorio, e um link morto aqui trava
// a pessoa sem explicacao. Tenta na ordem e usa o primeiro que responder.
const BASES = [
  'https://huggingface.co/ggerganov/whisper.cpp/resolve/main',
  'https://huggingface.co/ggml-org/whisper.cpp/resolve/main',
];

// Tamanho do arquivo e RAM aproximada com o modelo carregado. A RAM e o que
// decide: ela fica ocupada o tempo todo quando se usa o whisper-server.
const MODELOS = {
  tiny: { arquivo: 'ggml-tiny.bin', disco: 75, ram: 400, nota: 'erra demais em portugues' },
  base: { arquivo: 'ggml-base.bin', disco: 142, ram: 500, nota: 'erra nome proprio e palavra tecnica' },
  small: { arquivo: 'ggml-small.bin', disco: 466, ram: 1000, nota: 'bom equilibrio em pt-BR' },
  medium: { arquivo: 'ggml-medium.bin', disco: 1500, ram: 2600, nota: 'melhor pra voz, pesado' },
  large: { arquivo: 'ggml-large-v3.bin', disco: 3100, ram: 4400, nota: 'melhor de todos, so com folga de RAM' },
};

const mb = (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)} GB` : `${v} MB`);

/**
 * Recomenda o maior modelo que cabe deixando folga pro resto da maquina. Sem a
 * folga o Windows comeca a paginar, e ai TUDO fica lento — nao so o whisper.
 */
function recomendar(livreMb) {
  const FOLGA = 1500;
  const cabem = Object.entries(MODELOS).filter(([, m]) => m.ram + FOLGA <= livreMb);
  if (!cabem.length) return 'base';
  // "large" so entra se a pessoa pedir: o ganho sobre medium e pequeno e o
  // custo de latencia e grande.
  const ordem = ['base', 'small', 'medium'];
  return ordem.filter((n) => cabem.some(([nome]) => nome === n)).pop() || 'base';
}

async function baixar(arquivo, destino) {
  if (fs.existsSync(destino) && fs.statSync(destino).size > 1_000_000) {
    console.log(pc.dim(`  ja existe: ${path.basename(destino)}`));
    return;
  }

  const erros = [];
  for (const base of BASES) {
    const url = `${base}/${arquivo}`;
    console.log(pc.dim(`  baixando de ${new URL(base).pathname.split('/')[1]} — pode demorar...\n`));
    // Sem -s: a barra de progresso do curl e a unica forma de saber que um
    // download de centenas de MB nao travou.
    const result = await run('curl.exe', ['-L', '--fail', '-#', '-o', destino, url], {
      timeoutMs: 1_800_000,
    });
    if (fs.existsSync(destino) && fs.statSync(destino).size > 1_000_000) return;

    // Arquivo pela metade atrapalha a proxima tentativa: o teste de "ja existe"
    // olha o tamanho, e um resto de 200 bytes passaria batido depois.
    fs.rmSync(destino, { force: true });
    erros.push(`  ${url}\n    ${(result.stderr || 'sem resposta').trim().slice(0, 200)}`);
  }

  throw new Error(`nenhum espelho respondeu:\n${erros.join('\n')}`);
}

async function main() {
  console.log(pc.bold(pc.cyan('\n  Whisper — modelo de transcricao\n')));

  const livreMb = Math.round(os.freemem() / 1024 / 1024);
  const totalMb = Math.round(os.totalmem() / 1024 / 1024);
  const sugerido = recomendar(livreMb);

  console.log(`  RAM: ${mb(totalMb)} no total, ${pc.bold(mb(livreMb))} livre agora\n`);

  const pedido = process.argv[2];
  const escolha = pedido || sugerido;

  if (!MODELOS[escolha]) {
    console.log(pc.red(`  "${escolha}" nao existe. Opcoes:\n`));
    for (const [nome, m] of Object.entries(MODELOS)) {
      console.log(`    ${nome.padEnd(8)} ${mb(m.disco).padStart(8)} no disco, ~${mb(m.ram)} de RAM  ${pc.dim(m.nota)}`);
    }
    process.exit(1);
  }

  for (const [nome, m] of Object.entries(MODELOS)) {
    const cabe = m.ram + 1500 <= livreMb;
    const marca = nome === escolha ? pc.green('→') : ' ';
    const aviso = cabe ? '' : pc.yellow('  nao cabe na RAM livre');
    console.log(
      `  ${marca} ${nome.padEnd(8)} ${mb(m.disco).padStart(8)} disco, ~${mb(m.ram)} RAM  ${pc.dim(m.nota)}${aviso}`
    );
  }
  console.log();

  if (pedido && MODELOS[pedido].ram + 1500 > livreMb) {
    console.log(pc.yellow(`  Aviso: ${pedido} pede ~${mb(MODELOS[pedido].ram)} e voce tem ${mb(livreMb)} livre.`));
    console.log(pc.dim('  Vai funcionar, mas o Windows pode comecar a paginar — e ai tudo fica lento.\n'));
  }

  const modelo = MODELOS[escolha];
  const destino = path.join(DEST, modelo.arquivo).replace(/\\/g, '/');
  fs.mkdirSync(DEST, { recursive: true });

  await baixar(modelo.arquivo, destino);

  console.log(pc.green(`\n  Pronto: ${destino}\n`));

  // Modelo sem binario e um beco sem saida: o arquivo baixa, a linha do .env
  // entra, e o erro so aparece na primeira frase falada.
  const temBinario = await run('whisper-cli', ['--help'], { timeoutMs: 8000 });
  if (temBinario.code === -1) {
    console.log(pc.yellow('  Falta o whisper-cli — o modelo sozinho nao transcreve nada.\n'));
    console.log(pc.dim('  Baixe a release do Windows em:'));
    console.log(pc.dim('    https://github.com/ggml-org/whisper.cpp/releases'));
    console.log(pc.dim('  Descompacte e ponha a pasta no PATH, ou aponte o caminho inteiro'));
    console.log(pc.dim('  no STT_COMMAND abaixo, no lugar de "whisper-cli".\n'));
  }

  console.log(pc.bold('  Ponha no .env (a ultima linha de cada chave e a que vale):\n'));
  console.log(pc.cyan(`    Add-Content .env 'STT_COMMAND=whisper-cli -m ${destino} -f {file} -l pt -nt --no-prints'`));
  console.log(pc.cyan(`    Add-Content .env 'STT_SERVER_URL=http://127.0.0.1:8080'`));
  console.log(
    pc.dim(
      '\n  A segunda linha e o que evita recarregar o modelo do disco a cada\n' +
        '  comando. Sem ela, um modelo grande custa segundos em toda frase.\n'
    )
  );
  console.log(pc.dim('  Depois: npm run doctor  (confere) e npm run test:voice (fala com ele)\n'));
}

main().catch((err) => {
  console.error(pc.red(`\n  falhou: ${err.message}\n`));
  process.exit(1);
});
