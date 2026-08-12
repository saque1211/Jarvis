#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import pc from 'picocolors';
import { run, ps, psQuote } from '../src/platform/win32.js';

/**
 * Instala o Piper — TTS neural, local e gratuito. Soa muito melhor que o SAPI,
 * que e sintese dos anos 2000.
 *
 * Baixa o binario, baixa uma voz pt-BR, testa falando uma frase e imprime a
 * linha pro .env. Existe pra ninguem ter que cacar release e arquivo .onnx na
 * mao — sao quatro downloads de tres lugares diferentes.
 */

const DEST = process.env.PIPER_DIR || 'C:/piper';

const PIPER_URL =
  'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip';

const HF = 'https://huggingface.co/rhasspy/piper-voices/resolve/main';

// As vozes vivem num repositorio separado do binario, uma pasta por locutor.
const ATALHOS = {
  faber: 'pt/pt_BR/faber/medium/pt_BR-faber-medium',
  edresson: 'pt/pt_BR/edresson/low/pt_BR-edresson-low',
  // Vozes em ingles, pra quem quer o JARVIS falando como no filme.
  alan: 'en/en_GB/alan/medium/en_GB-alan-medium',
  northern: 'en/en_GB/northern_english_male/medium/en_GB-northern_english_male-medium',
  ryan: 'en/en_US/ryan/high/en_US-ryan-high',
};

/**
 * Aceita tres formas, da mais curta pra mais livre:
 *   faber                                        atalho daqui
 *   pt/pt_BR/cadu/medium/pt_BR-cadu-medium        caminho dentro do repositorio
 *   https://.../qualquer-voz.onnx                 URL direta de qualquer lugar
 *
 * A terceira existe porque o repositorio do Piper nao e o unico lugar com voz
 * pronta, e nao ha razao pra prender voce nele.
 */
function resolverVoz(arg) {
  if (!arg) return { nome: 'faber (padrao, pt-BR)', base: `${HF}/${ATALHOS.faber}`, arquivo: 'pt_BR-faber-medium' };

  if (/^https?:\/\//.test(arg)) {
    const base = arg.replace(/\.onnx(\.json)?$/, '');
    return { nome: `URL direta`, base, arquivo: path.basename(base) };
  }

  const caminho = ATALHOS[arg] || arg;
  const base = `${HF}/${caminho}`;
  return { nome: ATALHOS[arg] ? `${arg} (${caminho})` : caminho, base, arquivo: path.basename(caminho) };
}

/**
 * Lista o catalogo de verdade em vez de depender dos atalhos daqui — sao
 * centenas de vozes e elas mudam com o tempo.
 */
async function listarCatalogo(filtro) {
  const destino = path.join(os.tmpdir(), 'piper-voices.json');
  console.log(pc.dim('  buscando catalogo...\n'));
  await run('curl.exe', ['-L', '--fail', '-s', '-o', destino, `${HF}/voices.json`], {
    timeoutMs: 120000,
  });

  if (!fs.existsSync(destino)) {
    throw new Error(
      'nao consegui baixar o catalogo.\n' +
        '  Veja na mao: https://huggingface.co/rhasspy/piper-voices/tree/main'
    );
  }

  const catalogo = JSON.parse(fs.readFileSync(destino, 'utf8'));
  fs.rmSync(destino, { force: true });

  const alvo = (filtro || 'pt').toLowerCase();
  const vozes = Object.values(catalogo).filter((v) => {
    const codigo = (v.language?.code || '').toLowerCase();
    return alvo === 'todas' || codigo.startsWith(alvo);
  });

  if (!vozes.length) {
    console.log(pc.yellow(`  Nenhuma voz para "${filtro}".`));
    console.log(pc.dim('  Tente: pt, en, es, ou "todas".\n'));
    return;
  }

  console.log(pc.bold(pc.cyan(`  ${vozes.length} voz(es) para "${alvo}"\n`)));

  // Agrupa por locutor: a mesma voz aparece em varias qualidades, e listar
  // as tres separadas so polui.
  const porLocutor = new Map();
  for (const v of vozes) {
    const chave = `${v.language?.code}/${v.name}`;
    if (!porLocutor.has(chave)) porLocutor.set(chave, []);
    porLocutor.get(chave).push(v);
  }

  for (const [chave, variantes] of porLocutor) {
    const [codigo, nome] = chave.split('/');
    const qualidades = variantes.map((v) => v.quality).join(', ');
    const melhor = variantes.sort((a, b) => (b.quality === 'high' ? 1 : -1))[0];
    const caminho = Object.keys(melhor.files || {})
      .find((f) => f.endsWith('.onnx'))
      ?.replace(/\.onnx$/, '');

    console.log(`  ${pc.bold(nome.padEnd(22))} ${pc.dim(`${codigo}  [${qualidades}]`)}`);
    if (caminho) console.log(pc.dim(`    npm run voice:piper ${caminho}`));
  }

  console.log(pc.dim('\n  "high" soa melhor e ocupa mais disco; "low" e o contrario.\n'));
}

if (process.argv.includes('--lista')) {
  const filtro = process.argv[process.argv.indexOf('--lista') + 1];
  console.log(pc.bold(pc.cyan('\n  Catalogo do Piper\n')));
  await listarCatalogo(filtro && !filtro.startsWith('--') ? filtro : 'pt');
  process.exit(0);
}

const escolhida = resolverVoz(process.argv[2]);

async function baixar(url, destino) {
  if (fs.existsSync(destino) && fs.statSync(destino).size > 1000) {
    console.log(pc.dim(`  ja existe: ${path.basename(destino)}`));
    return;
  }
  console.log(pc.dim(`  baixando ${path.basename(destino)}...`));
  const result = await run('curl.exe', ['-L', '--fail', '-o', destino, url], {
    timeoutMs: 600000,
  });
  if (!fs.existsSync(destino) || fs.statSync(destino).size < 1000) {
    throw new Error(`falhou o download de ${url}\n${result.stderr}`);
  }
}

async function main() {
  console.log(pc.bold(pc.cyan('\n  Piper — voz neural local\n')));
  console.log(pc.dim(`  destino: ${DEST}`));
  console.log(pc.dim(`  voz:     ${escolhida.nome}\n`));

  fs.mkdirSync(DEST, { recursive: true });

  const zip = path.join(DEST, 'piper.zip');
  const exe = path.join(DEST, 'piper', 'piper.exe');

  if (!fs.existsSync(exe)) {
    await baixar(PIPER_URL, zip);
    console.log(pc.dim('  extraindo...'));
    await ps(`Expand-Archive -Path ${psQuote(zip)} -DestinationPath ${psQuote(DEST)} -Force`, {
      timeoutMs: 120000,
    });
    fs.rmSync(zip, { force: true });
  } else {
    console.log(pc.dim('  piper.exe ja instalado'));
  }

  if (!fs.existsSync(exe)) {
    throw new Error(`nao achei o piper.exe em ${exe} depois de extrair`);
  }

  // O .onnx e o modelo; o .onnx.json descreve como falar. Faltando um, nao roda.
  const modelo = path.join(DEST, `${escolhida.arquivo}.onnx`);
  await baixar(`${escolhida.base}.onnx`, modelo);
  await baixar(`${escolhida.base}.onnx.json`, `${modelo}.json`);

  const comando = `${exe.replace(/\\/g, '/')} --model ${modelo.replace(/\\/g, '/')} --output_file {out}`;

  console.log(pc.dim('\n  testando...\n'));
  const teste = path.join(DEST, 'teste.wav');
  const result = await run(exe, ['--model', modelo, '--output_file', teste], {
    timeoutMs: 60000,
    stdin: 'Oi, eu sou o Jarvis. Agora falo com a voz do Piper.',
  });

  if (!fs.existsSync(teste)) {
    throw new Error(`o Piper nao gerou audio: ${result.stderr}`);
  }

  await ps(`(New-Object System.Media.SoundPlayer ${psQuote(teste)}).PlaySync()`, {
    timeoutMs: 60000,
  });
  fs.rmSync(teste, { force: true });

  console.log(pc.bold(pc.green('  Funcionou. Ponha esta linha no .env:\n')));
  console.log(pc.green(`    TTS_COMMAND=${comando}\n`));
  console.log(pc.dim('  Com ela presente o SAPI sai de cena e JARVIS_VOICE deixa de valer —'));
  console.log(pc.dim('  quem manda na voz passa a ser o modelo .onnx.\n'));

  console.log(pc.bold('  Outras vozes:'));
  for (const [atalho, caminho] of Object.entries(ATALHOS)) {
    console.log(pc.dim(`    npm run voice:piper ${atalho.padEnd(10)} ${caminho}`));
  }
  console.log(pc.dim('\n  Ou qualquer outra: passe o caminho no repositorio ou uma URL direta.'));
  console.log(pc.dim('    npm run voice:piper pt/pt_BR/cadu/medium/pt_BR-cadu-medium'));
  console.log(pc.dim('    npm run voice:piper https://exemplo.com/voz.onnx'));
  console.log(pc.dim('  Catalogo: https://huggingface.co/rhasspy/piper-voices/tree/main\n'));
}

main().catch((err) => {
  console.error(pc.red(`\n  ${err.message}\n`));
  console.error(pc.dim('  Baixe na mao e rode de novo — o script pula o que ja existe:'));
  console.error(pc.dim(`    ${PIPER_URL}`));
  console.error(pc.dim(`       extraia em ${DEST}`));
  console.error(pc.dim(`    ${escolhida.base}.onnx`));
  console.error(pc.dim(`    ${escolhida.base}.onnx.json`));
  console.error(pc.dim(`       os dois em ${DEST}\n`));
  console.error(pc.dim('  Se essas URLs derem 404, o repositorio mudou de layout.'));
  console.error(pc.dim('  Navegue em https://huggingface.co/rhasspy/piper-voices/tree/main/pt/pt_BR'));
  console.error(pc.dim('  e pegue o .onnx e o .onnx.json de qualquer locutor.\n'));
  process.exit(1);
});
