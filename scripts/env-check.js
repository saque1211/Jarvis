#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { config } from '../src/core/config.js';

/**
 * Confere o .env e conserta o defeito mais comum dele.
 *
 * No PowerShell, `Add-Content` cola o texto novo no FIM DA ULTIMA LINHA quando
 * o arquivo nao termina com quebra de linha. O resultado e uma linha assim:
 *
 *   ELEVENLABS_VOICE_ID=abc123ELEVENLABS_API_KEY=sk_...
 *
 * A variavel de cima fica com lixo, a de baixo nem existe, e o erro que aparece
 * fala da chave errada. Isso ja aconteceu tres vezes neste projeto — com
 * STT_PROMPT, com JARVIS_SPEAKER_PORT e com a chave do ElevenLabs.
 *
 *   npm run env:check              aponta os problemas
 *   npm run env:check -- --corrigir  reescreve o arquivo separando as linhas
 */

const ARQUIVO = path.join(config.root, '.env');

/**
 * Onde a segunda variavel comeca dentro de uma linha colada.
 *
 * Achar isso so pelo texto nao funciona: em
 * "ELEVENLABS_VOICE_ID=9375G6zswFk7v9bKTVQFELEVENLABS_API_KEY=sk_...", as
 * maiusculas do proprio valor (KTVQF) se confundem com o inicio do nome, e o
 * corte sai em "KTVQFELEVENLABS_API_KEY". Entao a busca e pelos nomes QUE
 * EXISTEM — vindos do .env.example e das outras linhas do proprio arquivo.
 */
function nomesConhecidos(linhas) {
  const nomes = new Set();

  const exemplo = path.join(config.root, '.env.example');
  if (fs.existsSync(exemplo)) {
    for (const l of fs.readFileSync(exemplo, 'utf8').split(/\r?\n/)) {
      const m = l.match(/^#?\s*([A-Z][A-Z0-9_]{2,})=/);
      if (m) nomes.add(m[1]);
    }
  }
  for (const l of linhas) {
    const m = l.match(/^([A-Z][A-Z0-9_]{2,})=/);
    if (m) nomes.add(m[1]);
  }
  return [...nomes];
}

function acharColagem(linha, nomes) {
  const igual = linha.indexOf('=');
  if (igual < 0) return null;
  const primeira = linha.slice(0, igual);
  const resto = linha.slice(igual + 1);

  // Se houver mais de um nome conhecido no meio, vale o que aparece PRIMEIRO:
  // o valor da variavel de cima termina onde o proximo nome comeca.
  let melhor = null;
  for (const nome of nomes) {
    const pos = resto.indexOf(`${nome}=`);
    if (pos > 0 && (!melhor || pos < melhor.pos)) melhor = { nome, pos };
  }
  if (!melhor) return null;

  return {
    primeira,
    valorPrimeira: resto.slice(0, melhor.pos),
    segunda: melhor.nome,
    valorSegunda: resto.slice(melhor.pos + melhor.nome.length + 1),
  };
}

function analisar(linhas) {
  const problemas = [];
  const vistos = new Map();
  const nomes = nomesConhecidos(linhas);

  linhas.forEach((linha, i) => {
    const n = i + 1;
    const limpa = linha.trim();
    if (!limpa || limpa.startsWith('#')) return;

    if (!limpa.includes('=')) {
      problemas.push({ n, tipo: 'sem-igual', linha, msg: 'linha sem "=" — o dotenv ignora' });
      return;
    }

    const colada = acharColagem(limpa, nomes);
    if (colada) {
      problemas.push({
        n,
        tipo: 'colada',
        linha,
        msg: `duas variaveis na mesma linha: ${colada.primeira} e ${colada.segunda}`,
        conserto: [
          `${colada.primeira}=${colada.valorPrimeira}`,
          `${colada.segunda}=${colada.valorSegunda}`,
        ],
      });
      return;
    }

    const chave = limpa.split('=', 1)[0].trim();
    if (vistos.has(chave)) {
      problemas.push({
        n,
        tipo: 'repetida',
        linha,
        msg: `${chave} repetida (linha ${vistos.get(chave)} tambem) — vale ESTA, a ultima`,
      });
    }
    vistos.set(chave, n);
  });

  return problemas;
}

function main() {
  console.log(pc.bold(pc.cyan('\n  VEXIS — conferencia do .env\n')));

  if (!fs.existsSync(ARQUIVO)) {
    console.log(`  ${pc.red('X')}  Nao existe .env em ${ARQUIVO}\n`);
    process.exit(1);
  }

  const bruto = fs.readFileSync(ARQUIVO, 'utf8');
  const linhas = bruto.split(/\r?\n/);
  const problemas = analisar(linhas);
  const corrigir = process.argv.includes('--corrigir');

  // A causa raiz: sem quebra no fim, o proximo Add-Content cola.
  const terminaEmQuebra = /\r?\n$/.test(bruto);
  if (!terminaEmQuebra) {
    console.log(`  ${pc.yellow('--')}  o arquivo NAO termina com quebra de linha`);
    console.log(pc.dim('      o proximo Add-Content vai colar no fim da ultima linha\n'));
  }

  if (!problemas.length) {
    console.log(`  ${pc.green('OK')}  ${linhas.filter((l) => l.trim() && !l.startsWith('#')).length} variaveis, nenhuma colada ou duplicada`);
    if (!terminaEmQuebra && corrigir) {
      fs.writeFileSync(ARQUIVO, `${bruto}\n`, 'utf8');
      console.log(`  ${pc.green('OK')}  quebra de linha final acrescentada`);
    } else if (!terminaEmQuebra) {
      console.log(pc.cyan('\n  Corrija com: npm run env:check -- --corrigir'));
    }
    console.log();
    return;
  }

  for (const p of problemas) {
    const cor = p.tipo === 'repetida' ? pc.yellow('--') : pc.red('X ');
    console.log(`  ${cor}  linha ${p.n}: ${p.msg}`);
    if (p.conserto) {
      console.log(pc.dim('        vira:'));
      for (const l of p.conserto) {
        // Nunca imprime valor: .env tem chave, e isto vira print.
        const [k, v = ''] = l.split('=', 2);
        console.log(pc.dim(`          ${k}=<${v.length} caracteres>`));
      }
    }
  }

  const separaveis = problemas.filter((p) => p.conserto);
  if (!corrigir) {
    console.log(pc.cyan(`\n  Corrija com: npm run env:check -- --corrigir`));
    if (separaveis.length) {
      console.log(pc.dim(`  (separa ${separaveis.length} linha(s) colada(s) e garante a quebra final)`));
    }
    console.log(pc.dim('  Linha repetida nao e erro: o dotenv usa a ultima. So confira se e a que voce quer.\n'));
    return;
  }

  // Backup antes de reescrever: e o arquivo com as chaves da pessoa.
  const backup = `${ARQUIVO}.bak`;
  fs.writeFileSync(backup, bruto, 'utf8');

  const saida = [];
  linhas.forEach((linha, i) => {
    const p = problemas.find((x) => x.n === i + 1 && x.conserto);
    if (p) saida.push(...p.conserto);
    else saida.push(linha);
  });

  fs.writeFileSync(ARQUIVO, `${saida.join('\n').replace(/\n+$/, '')}\n`, 'utf8');
  console.log(`\n  ${pc.green('OK')}  ${separaveis.length} linha(s) separada(s), quebra final garantida`);
  console.log(pc.dim(`      copia do original em ${path.basename(backup)}\n`));
}

main();
