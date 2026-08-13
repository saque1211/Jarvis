#!/usr/bin/env node
import path from 'node:path';
import pc from 'picocolors';
import { config } from '../src/core/config.js';
import { route } from '../src/core/router.js';
import { ENDPOINT } from '../src/core/llm.js';
import { loadSkills, toolSpecs } from '../src/core/registry.js';
import { estimateTokens } from '../src/core/preselect.js';

/**
 * Testa o cerebro que esta configurado agora — seja Groq, OpenAI, Anthropic ou
 * um proxy local. Faz UM comando de verdade e mostra o que ele custou: quais
 * tools rodaram, quanto demorou, quantos tokens e, quando o preco e conhecido,
 * quanto isso da em dinheiro.
 *
 * O `doctor` so confere se a chave existe. Este aqui prova que ela funciona.
 *
 *   npm run llm:test
 *   npm run llm:test -- "poe um timer de 5 minutos"
 */

// Precos por milhao de tokens. So entram os que eu tenho como verificados —
// modelo sem preco aqui mostra os tokens e diz que o preco nao esta cadastrado,
// em vez de inventar um numero que vira decisao errada.
const PRECOS = {
  'claude-haiku-4-5': { entrada: 1, saida: 5 },
  'claude-sonnet-5': { entrada: 3, saida: 15, promo: { entrada: 2, saida: 10, ate: '2026-08-31' } },
  'claude-sonnet-4-6': { entrada: 3, saida: 15 },
  'claude-opus-5': { entrada: 5, saida: 25 },
  'claude-opus-4-8': { entrada: 5, saida: 25 },
  'claude-opus-4-7': { entrada: 5, saida: 25 },
  'claude-opus-4-6': { entrada: 5, saida: 25 },
  'claude-fable-5': { entrada: 10, saida: 50 },
};

/** Casa "claude-haiku-4-5-20251001" com a entrada "claude-haiku-4-5". */
function precoDe(model) {
  const chave = Object.keys(PRECOS).find((k) => model.startsWith(k));
  if (!chave) return null;
  const p = PRECOS[chave];
  if (p.promo && new Date() <= new Date(`${p.promo.ate}T23:59:59Z`)) {
    return { ...p.promo, nota: `promo ate ${p.promo.ate}` };
  }
  return p;
}

/**
 * Cache de prompt: escrever custa 1,25x a entrada, ler custa 0,1x. O `entrada`
 * que a Anthropic devolve NAO inclui esses dois — por isso somam separado.
 * (No caminho OpenAI o cacheLido ja esta dentro do `entrada`, entao o desconto
 * dele entra como abatimento.)
 */
function custoEm(usage, preco, provider) {
  if (!preco) return null;
  const M = 1_000_000;

  if (provider === 'anthropic') {
    return (
      (usage.entrada * preco.entrada +
        usage.cacheEscrito * preco.entrada * 1.25 +
        usage.cacheLido * preco.entrada * 0.1 +
        usage.saida * preco.saida) /
      M
    );
  }

  const naoCacheado = Math.max(0, usage.entrada - usage.cacheLido);
  return (
    (naoCacheado * preco.entrada + usage.cacheLido * preco.entrada * 0.1 + usage.saida * preco.saida) /
    M
  );
}

const dolar = (v) => (v < 0.01 ? `$${v.toFixed(5)}` : `$${v.toFixed(4)}`);

async function main() {
  const comando = process.argv.slice(2).join(' ').trim() || 'que horas sao';

  console.log(pc.bold(pc.cyan('\n  JARVIS — teste do cerebro\n')));

  const { provider, keyName, apiKey, model, fastModel, toolBudget } = config.llm;

  console.log(pc.bold('  Configuracao'));
  console.log(`    provedor    ${pc.bold(provider)}`);
  console.log(`    modelo      ${model}`);
  console.log(`    modelo leve ${fastModel} ${pc.dim('(so quando ha pre-selecao)')}`);
  // Sempre visivel: um endereco sobrando no .env e a causa mais comum de
  // "fetch failed", e sem ver pra onde ele aponta nao da pra desconfiar.
  const alvo = ENDPOINT[provider];
  const oficial = /api\.(anthropic|groq)\.com|api\.openai\.com/.test(alvo || '');
  console.log(`    endpoint    ${alvo}${oficial ? '' : pc.yellow('  ← nao e o oficial, veio do .env')}`);

  if (!apiKey) {
    console.log(`\n  ${pc.red('X')}  ${keyName} ausente no .env — o teste para aqui.\n`);
    console.log(pc.dim(`     O .env fica em ${path.join(config.root, '.env')}`));

    // Dizer so o que falta manda a pessoa atras de uma chave que ela talvez ja
    // tenha noutro provedor. Mostra o que EXISTE e como trocar numa linha.
    const outros = [
      ['groq', 'GROQ_API_KEY', process.env.GROQ_API_KEY],
      ['openai', 'OPENAI_API_KEY', process.env.OPENAI_API_KEY],
      ['anthropic', 'ANTHROPIC_API_KEY', process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY],
    ].filter(([nome, , chave]) => chave && nome !== provider);

    if (outros.length) {
      console.log(`\n     Voce ja tem chave de: ${outros.map(([n]) => pc.bold(n)).join(', ')}.`);
      console.log('     Pra usar uma delas, acrescente no fim do .env:');
      for (const [nome] of outros) {
        // Um provedor apontado pra endereco proprio depende de um servidor
        // ligado na maquina — sugerir sem avisar so troca um erro por outro.
        const destino = ENDPOINT[nome];
        const proprio = destino && !/api\.(anthropic|groq|openai)\.com/.test(destino);
        console.log(
          pc.cyan(`       Add-Content .env 'LLM_PROVIDER=${nome}'`) +
            (proprio ? pc.yellow(`   ← aponta pra ${destino}, precisa estar rodando`) : '')
        );
      }
      console.log(pc.dim('     (chave repetida no .env: vale a ultima linha)'));
    } else {
      console.log('\n     Nenhum provedor tem chave configurada. Pegue uma em:');
      console.log(pc.dim('       Groq (gratis)  console.groq.com/keys'));
      console.log(pc.dim('       Anthropic      platform.claude.com/settings/keys'));
      console.log(pc.dim('       OpenAI         platform.openai.com/api-keys'));
    }
    console.log(pc.dim('\n     Cole a chave no .env, nunca num chat ou print.'));
    process.exit(1);
  }
  // Nunca imprime a chave: este output costuma virar print pra pedir ajuda.
  console.log(`    ${keyName}  ${pc.green('presente')} ${pc.dim(`(${apiKey.length} caracteres)`)}`);

  const skills = await loadSkills();
  const tools = toolSpecs(skills);
  const tokensDeTool = estimateTokens(tools);
  console.log(`    tools       ${tools.length} (~${tokensDeTool} tokens)`);
  if (toolBudget && tokensDeTool > toolBudget) {
    console.log(
      `    ${pc.yellow('--')}          acima do teto de ${toolBudget}: vai pre-selecionar skills antes`
    );
  }

  console.log(pc.bold(`\n  Comando de teste`));
  console.log(`    ${pc.italic(`"${comando}"`)}\n`);

  const inicio = Date.now();
  let resultado;
  try {
    resultado = await route(comando, {
      source: 'llm-test',
      onNote: (n) => console.log(pc.dim(`    · ${n}`)),
      onStep: (s) => console.log(pc.dim(`    · tool ${s.tool}`)),
    });
  } catch (err) {
    console.log(`\n  ${pc.red('X')}  ${err.message}\n`);
    // A cadeia de `cause` e onde mora o motivo de verdade. Escondida, todo
    // problema de rede vira a mesma mensagem sem saida.
    let causa = err.cause;
    for (let i = 0; i < 4 && causa; i++) {
      const detalhe = [causa.code, causa.message].filter(Boolean).join(': ');
      if (detalhe) console.log(pc.dim(`       causa: ${detalhe}`));
      causa = causa.cause;
    }
    process.exit(1);
  }

  const { usage, timings, steps } = resultado;

  console.log(`\n  ${pc.green('OK')}   ${pc.bold(resultado.reply)}\n`);

  console.log(pc.bold('  O que rodou'));
  if (steps.length) {
    for (const s of steps) {
      const marca = s.ok ? pc.green('ok') : pc.red('erro');
      console.log(`    ${marca}  ${s.tool}${s.error ? pc.dim(` — ${s.error}`) : ''}`);
    }
  } else {
    console.log(pc.dim('    nenhuma tool — o modelo respondeu direto'));
  }

  console.log(pc.bold('\n  Tempo'));
  console.log(`    modelo   ${(timings.llm / 1000).toFixed(1)}s`);
  if (timings.preselect) console.log(`    escolha  ${(timings.preselect / 1000).toFixed(1)}s`);
  if (timings.tools) console.log(`    tools    ${(timings.tools / 1000).toFixed(1)}s`);
  console.log(`    ${pc.bold('total')}    ${pc.bold(((Date.now() - inicio) / 1000).toFixed(1) + 's')}`);

  console.log(pc.bold('\n  Tokens'));
  if (!usage || !usage.chamadas) {
    console.log(pc.dim('    o provedor nao informou consumo nesta chamada'));
  } else {
    console.log(`    idas ao modelo  ${usage.chamadas}`);
    console.log(`    entrada         ${usage.entrada}`);
    if (usage.cacheEscrito) console.log(`    cache escrito   ${usage.cacheEscrito}`);
    if (usage.cacheLido) console.log(`    cache lido      ${usage.cacheLido} ${pc.dim('(custa 10%)')}`);
    console.log(`    saida           ${usage.saida}`);

    const preco = precoDe(model);
    if (!preco) {
      console.log(
        pc.dim(`\n    preco de "${model}" nao esta cadastrado aqui — confira na pagina do provedor`)
      );
    } else {
      const custo = custoEm(usage, preco, provider);
      console.log(pc.bold(`\n    custo deste comando  ${dolar(custo)}`));
      if (preco.nota) console.log(pc.dim(`    (${preco.nota})`));
      // Extrapolar de um comando so mente nas duas pontas: com o cache quente
      // sai barato demais, sem cache sai caro demais. Diz qual dos dois e.
      const ressalva = usage.cacheLido
        ? 'se todos pegarem o cache quente — na pratica sai mais'
        : 'sem cache nenhum — na pratica sai menos';
      console.log(pc.dim(`    50 por dia ≈ $${(custo * 50 * 30).toFixed(2)}/mes (${ressalva})`));
      if (!usage.cacheLido) {
        console.log(
          pc.dim('\n    o cache nao foi lido: primeiro comando, ou passaram 5min do anterior.')
        );
        console.log(pc.dim('    rode de novo agora pra ver o preco com o cache quente.'));
      }
    }
  }

  console.log();
}

main().catch((err) => {
  console.error(pc.red(`\n  falhou: ${err.message}\n`));
  process.exit(1);
});
