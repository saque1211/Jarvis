#!/usr/bin/env node
import pc from 'picocolors';
import { config } from '../src/core/config.js';
import { readRuntime } from '../src/core/state.js';
import { sttEngineName, promptDeVocabulario } from '../src/voice/stt.js';
import { loadSkills, toolSpecs } from '../src/core/registry.js';
import { estimateTokens } from '../src/core/preselect.js';

/**
 * As ultimas conversas, do jeito que aconteceram.
 *
 * Existe porque "ele ficou burro" pode ser duas coisas MUITO diferentes — ele
 * ouviu errado, ou ouviu certo e respondeu mal — e as duas se consertam em
 * lugares opostos. Uma linha de `voce:` mostra qual das duas e, e isso vale
 * mais que qualquer palpite meu.
 *
 *   npm run log            as ultimas conversas
 *   npm run log -- 3       so as 3 ultimas
 */

const quantas = Number(process.argv[2]) || 8;
const runtime = readRuntime();

console.log(pc.bold(pc.cyan('\n  VEXIS — ultimas conversas\n')));

// ── como ele esta montado agora ──────────────────────────────────────────────
const skills = await loadSkills();
const tools = toolSpecs(skills);
const tokensDeTools = estimateTokens(tools);
const orcamento = config.llm.toolBudget;
const preselectLigado = Boolean(orcamento && tokensDeTools > orcamento);

console.log(`  cerebro    ${config.llm.provider} / ${config.model}`);
console.log(`  gatilho    ${config.voice.trigger}` +
  (config.voice.trigger === 'escuta'
    ? pc.dim(`  ("${config.voice.wakeWord}", tolerancia ${config.voice.wakeTolerancia})`)
    : ''));
console.log(`  stt        ${(await sttEngineName()) || pc.red('nenhum')}` +
  (config.voice.sttServerUrl ? pc.dim(`  servidor: ${config.voice.sttServerUrl}`) : pc.yellow('  sem servidor')));
console.log(`  tools      ${tools.length} em ${skills.length} skills` + pc.dim(`  ~${tokensDeTools} tokens`));

// A pre-selecao muda o comportamento inteiro: com ela ligada o modelo ve 2-3
// skills em vez de todas, e escolher errado ali derruba o comando todo. Se ela
// ligou sem ninguem pedir, e a primeira coisa a olhar.
if (preselectLigado) {
  console.log(
    `  preselect  ${pc.yellow('LIGADO')}` +
      pc.dim(`  (JARVIS_TOOL_BUDGET=${orcamento} e as tools passam disso)`)
  );
  console.log(pc.yellow('             o modelo ve so 2-3 skills por comando, nao todas.'));
  console.log(pc.yellow('             tire JARVIS_TOOL_BUDGET do .env pra desligar.'));
} else {
  console.log(`  preselect  desligado` + pc.dim('  (o modelo ve todas as tools)'));
}

const prompt = promptDeVocabulario();
console.log(`\n  vocabulario que vai pro whisper (${prompt.length} chars):`);
console.log(pc.dim(`    "${prompt.slice(0, 150)}${prompt.length > 150 ? '...' : ''}"`));

// ── as conversas ─────────────────────────────────────────────────────────────
const comandos = (runtime.commands || []).slice(-quantas).reverse();
const atividade = runtime.activity || [];

console.log(pc.bold(`\n  ultimas ${comandos.length} conversas\n`));

if (!comandos.length) {
  console.log(pc.dim('  (nenhuma ainda — fale com ele e rode isto de novo)\n'));
} else {
  for (const c of comandos) {
    const quando = new Date(c.at);
    const hora = quando.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    // As tools que rodaram por volta desse comando. Sem elas nao da pra
    // separar "escolheu a ferramenta errada" de "escolheu a certa e ela falhou".
    const perto = atividade.filter((a) => {
      const dt = new Date(a.at) - quando;
      return dt >= -1000 && dt < 30000;
    });

    console.log(`  ${pc.dim(hora)}`);
    console.log(`    ${pc.green('voce  ')} ${c.text}`);
    console.log(`    ${pc.magenta('vexis ')} ${c.reply || pc.dim('(sem resposta)')}`);
    if (perto.length) {
      console.log(
        `    ${pc.yellow('tools ')} ${perto.map((a) => (a.ok ? a.tool : pc.red(`${a.tool} FALHOU`))).join(', ')}`
      );
    }
    console.log();
  }
}

const uso = runtime.uso;
if (uso?.comandos) {
  console.log(pc.dim(`  hoje: ${uso.comandos} comandos, ${uso.entrada} tokens de entrada, ${uso.saida} de saida\n`));
}
