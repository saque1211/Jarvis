import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { run } from '../platform/win32.js';
import { config } from '../core/config.js';
import { appendDaily } from '../core/vault.js';

/**
 * Skill: build, testes e deploy.
 *
 * Detecta o gerenciador de pacotes pelo lockfile em vez de assumir npm, e
 * trata push/force como operacao que exige confirmacao.
 */

function resolveProject(dir) {
  if (!dir) return process.cwd();
  const candidate = path.resolve(dir);
  if (fs.existsSync(candidate)) return candidate;
  // Nome solto: procura em ~/Projects.
  const workspace = process.env.JARVIS_PROJECTS_DIR || path.join(os.homedir(), 'Projects');
  const guess = path.join(workspace, dir);
  return fs.existsSync(guess) ? guess : candidate;
}

function packageManager(dir) {
  if (fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(dir, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(dir, 'bun.lockb'))) return 'bun';
  return 'npm';
}

function tail(text, lines = 40) {
  return text.split('\n').slice(-lines).join('\n');
}

async function githubApi(endpoint, options = {}) {
  if (!config.github.token) throw new Error('Falta GITHUB_TOKEN no .env.');
  const res = await fetch(`https://api.github.com${endpoint}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${config.github.token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export default {
  name: 'build',
  description: 'Compilar projetos, rodar testes, git e GitHub Actions.',
  tools: [
    {
      name: 'run_npm_script',
      description:
        'Roda um script do package.json (build, test, dev, lint...). ' +
        'Detecta sozinho se o projeto usa npm, pnpm, yarn ou bun.',
      input_schema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Caminho ou nome do projeto em ~/Projects.' },
          script: { type: 'string', description: 'Nome do script. Ex: "build", "test".' },
        },
        required: ['script'],
      },
      handler: async ({ project, script }) => {
        const dir = resolveProject(project);
        const pkgPath = path.join(dir, 'package.json');
        if (!fs.existsSync(pkgPath)) return `Sem package.json em ${dir}.`;

        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (!pkg.scripts?.[script]) {
          return `O script "${script}" nao existe. Disponiveis: ${Object.keys(pkg.scripts || {}).join(', ')}.`;
        }

        const pm = packageManager(dir);
        const result = await run(pm, ['run', script], { cwd: dir, timeoutMs: 600000 });
        appendDaily('Build', `\`${pm} run ${script}\` em ${path.basename(dir)} — exit ${result.code}`);

        const output = tail([result.stdout, result.stderr].filter(Boolean).join('\n'));
        return result.ok
          ? `${script} passou.\n${output}`
          : `${script} falhou (exit ${result.code}).\n${output}`;
      },
    },
    {
      name: 'install_dependencies',
      description: 'Instala as dependencias do projeto com o gerenciador certo.',
      input_schema: {
        type: 'object',
        properties: { project: { type: 'string' } },
      },
      handler: async ({ project }) => {
        const dir = resolveProject(project);
        const pm = packageManager(dir);
        const result = await run(pm, ['install'], { cwd: dir, timeoutMs: 600000 });
        return result.ok
          ? `Dependencias instaladas com ${pm}.`
          : `Instalacao falhou:\n${tail(result.stderr || result.stdout, 20)}`;
      },
    },
    {
      name: 'git_status',
      description: 'Mostra o estado do repositorio: branch, arquivos modificados e commits nao enviados.',
      input_schema: {
        type: 'object',
        properties: { project: { type: 'string' } },
      },
      handler: async ({ project }) => {
        const dir = resolveProject(project);
        const [status, branch, ahead] = await Promise.all([
          run('git', ['status', '--porcelain'], { cwd: dir }),
          run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir }),
          run('git', ['rev-list', '--count', '@{u}..HEAD'], { cwd: dir }),
        ]);

        if (!branch.ok) return `${dir} nao e um repositorio git.`;

        const changed = status.stdout ? status.stdout.split('\n').length : 0;
        const unpushed = ahead.ok ? Number(ahead.stdout) : 0;
        const detail = status.stdout ? `\n${status.stdout.slice(0, 1500)}` : '';
        return (
          `Branch ${branch.stdout}, ${changed} arquivo(s) modificado(s), ` +
          `${unpushed} commit(s) sem push.${detail}`
        );
      },
    },
    {
      name: 'git_commit',
      description: 'Adiciona tudo e faz commit. Nao faz push — use git_push separado.',
      input_schema: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          message: { type: 'string', description: 'Mensagem do commit.' },
        },
        required: ['message'],
      },
      handler: async ({ project, message }) => {
        const dir = resolveProject(project);
        const status = await run('git', ['status', '--porcelain'], { cwd: dir });
        if (!status.stdout) return 'Nada pra commitar — a arvore esta limpa.';

        await run('git', ['add', '-A'], { cwd: dir });
        const result = await run('git', ['commit', '-m', message], { cwd: dir });
        if (!result.ok) return `Commit falhou: ${result.stderr || result.stdout}`;
        appendDaily('Git', `Commit em ${path.basename(dir)}: ${message}`);
        return `Commitei: ${message}.`;
      },
    },
    {
      name: 'git_push',
      description:
        'Envia os commits pro remoto. force=true e DESTRUTIVO — so use apos o usuario confirmar.',
      input_schema: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          branch: { type: 'string', description: 'Padrao: a branch atual.' },
          force: { type: 'boolean' },
          confirmed: { type: 'boolean', description: 'Obrigatorio true quando force=true.' },
        },
      },
      handler: async ({ project, branch, force, confirmed }) => {
        const dir = resolveProject(project);
        if (force && !confirmed) {
          return 'Force push reescreve historico. Confirme com o usuario e chame com confirmed=true.';
        }
        const current = branch || (await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir })).stdout;
        const args = ['push', '-u', 'origin', current];
        if (force) args.push('--force-with-lease');

        const result = await run('git', args, { cwd: dir, timeoutMs: 120000 });
        if (!result.ok) return `Push falhou: ${tail(result.stderr, 10)}`;
        return `Push feito pra ${current}.`;
      },
    },
    {
      name: 'run_tests',
      description: 'Roda a suite de testes do projeto e resume o resultado.',
      input_schema: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          pattern: { type: 'string', description: 'Filtro de arquivos/testes.' },
        },
      },
      handler: async ({ project, pattern }) => {
        const dir = resolveProject(project);
        const pkgPath = path.join(dir, 'package.json');

        // Projeto Python: pytest.
        if (!fs.existsSync(pkgPath)) {
          const result = await run('pytest', pattern ? ['-k', pattern] : [], {
            cwd: dir,
            timeoutMs: 600000,
          });
          return `${result.ok ? 'Testes passaram' : 'Testes falharam'}:\n${tail(result.stdout || result.stderr)}`;
        }

        const pm = packageManager(dir);
        const args = ['run', 'test'];
        if (pattern) args.push('--', pattern);
        const result = await run(pm, args, { cwd: dir, timeoutMs: 600000 });
        appendDaily('Testes', `${path.basename(dir)} — ${result.ok ? 'passou' : 'falhou'}`);
        return `${result.ok ? 'Testes passaram' : 'Testes falharam'}:\n${tail(result.stdout || result.stderr)}`;
      },
    },
    {
      name: 'github_actions_status',
      description:
        'Ve o estado dos ultimos workflows do GitHub Actions de um repositorio. ' +
        'Sem repo, usa GITHUB_DEFAULT_REPO do .env.',
      input_schema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Formato "dono/repo".' },
          limit: { type: 'number', description: 'Quantas execucoes. Padrao 5.' },
        },
      },
      handler: async ({ repo, limit = 5 }) => {
        const target = repo || config.github.defaultRepo;
        if (!target) return 'Diga qual repositorio, ou configure GITHUB_DEFAULT_REPO no .env.';

        try {
          const data = await githubApi(`/repos/${target}/actions/runs?per_page=${limit}`);
          if (!data.workflow_runs?.length) return `Nenhuma execucao de workflow em ${target}.`;

          return data.workflow_runs
            .map((r) => {
              const status = r.status === 'completed' ? r.conclusion : r.status;
              const when = new Date(r.created_at).toLocaleString('pt-BR');
              return `${r.name}: ${status} (${r.head_branch}, ${when})`;
            })
            .join('\n');
        } catch (err) {
          return err.message;
        }
      },
    },
    {
      name: 'github_trigger_workflow',
      description: 'Dispara um workflow do GitHub Actions manualmente (precisa de workflow_dispatch).',
      input_schema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Formato "dono/repo".' },
          workflow: { type: 'string', description: 'Nome do arquivo. Ex: "deploy.yml".' },
          ref: { type: 'string', description: 'Branch. Padrao: main.' },
        },
        required: ['workflow'],
      },
      handler: async ({ repo, workflow, ref = 'main' }) => {
        const target = repo || config.github.defaultRepo;
        if (!target) return 'Diga qual repositorio, ou configure GITHUB_DEFAULT_REPO no .env.';
        try {
          await githubApi(`/repos/${target}/actions/workflows/${workflow}/dispatches`, {
            method: 'POST',
            body: JSON.stringify({ ref }),
          });
          return `Disparei ${workflow} em ${target} na branch ${ref}.`;
        } catch (err) {
          return err.message;
        }
      },
    },
  ],
};
