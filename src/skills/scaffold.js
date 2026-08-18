import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { run } from '../platform/win32.js';
import { config } from '../core/config.js';

/**
 * Skill: scaffold de codigo.
 *
 * Projetos novos delegam pros geradores oficiais (create-vite, create-next-app)
 * em vez de eu manter templates que envelhecem. Componentes e arquivos avulsos
 * eu escrevo direto, porque ai o valor esta em ser instantaneo.
 */

function workspaceRoot() {
  return process.env.JARVIS_PROJECTS_DIR || path.join(os.homedir(), 'Projects');
}

function pascal(name) {
  return name
    .replace(/[^a-zA-Z0-9]+(.)/g, (_, c) => c.toUpperCase())
    .replace(/^(.)/, (_, c) => c.toUpperCase());
}

const COMPONENT_TEMPLATES = {
  tsx: (name) => `interface ${name}Props {
  children?: React.ReactNode;
}

export function ${name}({ children }: ${name}Props) {
  return <div className="${name.toLowerCase()}">{children}</div>;
}
`,
  jsx: (name) => `export function ${name}({ children }) {
  return <div className="${name.toLowerCase()}">{children}</div>;
}
`,
  'tsx-state': (name) => `import { useState } from 'react';

interface ${name}Props {
  initial?: number;
}

export function ${name}({ initial = 0 }: ${name}Props) {
  const [value, setValue] = useState(initial);

  return (
    <div className="${name.toLowerCase()}">
      <span>{value}</span>
      <button onClick={() => setValue((v) => v + 1)}>+</button>
    </div>
  );
}
`,
  hook: (name) => {
    const hookName = name.startsWith('use') ? name : `use${name}`;
    return `import { useEffect, useState } from 'react';

export function ${hookName}() {
  const [state, setState] = useState(null);

  useEffect(() => {
    let cancelled = false;
    // efeito aqui
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
`;
  },
};

export default {
  name: 'scaffold',
  // Controla a maquina local: so faz sentido onde ela esta. O servidor na
  // nuvem carrega o registro sem estas, e o agente do PC carrega so estas.
  platform: 'win32',
  description: 'Gerar projetos, componentes React e boilerplate de codigo.',
  tools: [
    {
      name: 'create_project',
      description:
        'Cria um projeto novo usando o gerador oficial do stack. ' +
        'Stacks: vite-react, vite-react-ts, next, node, express, python, fastapi.',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Nome da pasta do projeto.' },
          stack: {
            type: 'string',
            enum: ['vite-react', 'vite-react-ts', 'next', 'node', 'express', 'python', 'fastapi'],
          },
          directory: { type: 'string', description: 'Onde criar. Padrao: ~/Projects.' },
        },
        required: ['name', 'stack'],
      },
      handler: async ({ name, stack, directory }) => {
        const base = directory ? path.resolve(directory) : workspaceRoot();
        fs.mkdirSync(base, { recursive: true });
        const target = path.join(base, name);
        if (fs.existsSync(target)) return `Ja existe uma pasta em ${target}.`;

        // Stacks JS delegam pro gerador oficial.
        const generators = {
          'vite-react': ['npm', ['create', 'vite@latest', name, '--', '--template', 'react']],
          'vite-react-ts': ['npm', ['create', 'vite@latest', name, '--', '--template', 'react-ts']],
          next: ['npx', ['--yes', 'create-next-app@latest', name, '--ts', '--eslint', '--app', '--no-tailwind', '--no-src-dir', '--import-alias', '@/*']],
        };

        if (generators[stack]) {
          const [cmd, args] = generators[stack];
          const result = await run(cmd, args, { cwd: base, timeoutMs: 300000 });
          if (!result.ok) return `Gerador falhou: ${(result.stderr || result.stdout).slice(0, 800)}`;
          return `Projeto ${stack} criado em ${target}. Rode npm install la dentro.`;
        }

        // Stacks simples eu escrevo direto — mais rapido que baixar um gerador.
        fs.mkdirSync(target, { recursive: true });

        if (stack === 'node' || stack === 'express') {
          const pkg = {
            name,
            version: '0.1.0',
            type: 'module',
            main: 'src/index.js',
            scripts: { start: 'node src/index.js', dev: 'node --watch src/index.js' },
            ...(stack === 'express' ? { dependencies: { express: '^4.21.0' } } : {}),
          };
          fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify(pkg, null, 2));
          fs.mkdirSync(path.join(target, 'src'), { recursive: true });
          fs.writeFileSync(
            path.join(target, 'src', 'index.js'),
            stack === 'express'
              ? `import express from 'express';\n\nconst app = express();\napp.use(express.json());\n\napp.get('/health', (req, res) => res.json({ ok: true }));\n\nconst port = process.env.PORT || 3000;\napp.listen(port, () => console.log(\`ouvindo em :\${port}\`));\n`
              : `console.log('${name} rodando');\n`
          );
          fs.writeFileSync(path.join(target, '.gitignore'), 'node_modules/\n.env\n');
        }

        if (stack === 'python' || stack === 'fastapi') {
          fs.mkdirSync(path.join(target, 'src'), { recursive: true });
          fs.writeFileSync(
            path.join(target, 'src', 'main.py'),
            stack === 'fastapi'
              ? `from fastapi import FastAPI\n\napp = FastAPI()\n\n\n@app.get("/health")\ndef health():\n    return {"ok": True}\n`
              : `def main():\n    print("${name} rodando")\n\n\nif __name__ == "__main__":\n    main()\n`
          );
          fs.writeFileSync(
            path.join(target, 'requirements.txt'),
            stack === 'fastapi' ? 'fastapi\nuvicorn\n' : ''
          );
          fs.writeFileSync(path.join(target, '.gitignore'), '__pycache__/\n.venv/\n.env\n');
        }

        fs.writeFileSync(path.join(target, 'README.md'), `# ${name}\n`);
        await run('git', ['init'], { cwd: target });
        return `Projeto ${stack} criado em ${target}.`;
      },
    },
    {
      name: 'create_component',
      description:
        'Cria um componente React (ou hook) num projeto existente. ' +
        'Variantes: tsx, jsx, tsx-state (com useState), hook.',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Nome do componente. Eu converto pra PascalCase.' },
          project_dir: { type: 'string', description: 'Raiz do projeto.' },
          variant: { type: 'string', enum: ['tsx', 'jsx', 'tsx-state', 'hook'], description: 'Padrao tsx.' },
          subdirectory: { type: 'string', description: 'Subpasta dentro de src. Padrao "components".' },
          with_styles: { type: 'boolean', description: 'Cria tambem um .css junto.' },
        },
        required: ['name', 'project_dir'],
      },
      handler: async ({ name, project_dir, variant = 'tsx', subdirectory = 'components', with_styles }) => {
        const root = path.resolve(project_dir);
        if (!fs.existsSync(root)) return `Projeto nao existe: ${root}`;

        const componentName = pascal(name);
        const srcDir = fs.existsSync(path.join(root, 'src')) ? path.join(root, 'src') : root;
        const dir = path.join(srcDir, subdirectory);
        fs.mkdirSync(dir, { recursive: true });

        const ext = variant === 'hook' ? 'ts' : variant.startsWith('tsx') ? 'tsx' : 'jsx';
        const fileName = variant === 'hook'
          ? `${componentName.startsWith('Use') ? `use${componentName.slice(3)}` : `use${componentName}`}.${ext}`
          : `${componentName}.${ext}`;
        const file = path.join(dir, fileName);

        if (fs.existsSync(file)) return `Ja existe: ${file}`;

        fs.writeFileSync(file, COMPONENT_TEMPLATES[variant](componentName), 'utf8');

        const created = [file];
        if (with_styles && variant !== 'hook') {
          const cssFile = path.join(dir, `${componentName}.css`);
          fs.writeFileSync(cssFile, `.${componentName.toLowerCase()} {\n  display: block;\n}\n`, 'utf8');
          created.push(cssFile);
        }

        return `Criei ${created.map((f) => path.relative(root, f)).join(' e ')}.`;
      },
    },
    {
      name: 'create_file',
      description: 'Cria um arquivo com o conteudo que eu gerar. Use pra boilerplate sob medida.',
      input_schema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Caminho completo do arquivo.' },
          content: { type: 'string', description: 'Conteudo completo.' },
          overwrite: { type: 'boolean', description: 'Sobrescreve se ja existir. Confirme antes.' },
        },
        required: ['file_path', 'content'],
      },
      handler: async ({ file_path, content, overwrite }) => {
        const full = path.resolve(file_path);
        if (fs.existsSync(full) && !overwrite) {
          return `Ja existe ${full}. Pergunte ao usuario e chame com overwrite=true se ele autorizar.`;
        }
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content, 'utf8');
        return `Escrevi ${full} (${content.split('\n').length} linhas).`;
      },
    },
    {
      name: 'list_projects',
      description: 'Lista os projetos na pasta de trabalho, com data da ultima modificacao.',
      input_schema: {
        type: 'object',
        properties: { directory: { type: 'string', description: 'Padrao: ~/Projects.' } },
      },
      handler: async ({ directory }) => {
        const base = directory ? path.resolve(directory) : workspaceRoot();
        if (!fs.existsSync(base)) return `Pasta de projetos nao existe: ${base}`;

        const projects = fs
          .readdirSync(base, { withFileTypes: true })
          .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
          .map((e) => {
            const full = path.join(base, e.name);
            return { name: e.name, mtime: fs.statSync(full).mtimeMs };
          })
          .sort((a, b) => b.mtime - a.mtime);

        if (!projects.length) return `Nenhum projeto em ${base}.`;
        return projects
          .slice(0, 20)
          .map((p) => `${p.name} — mexido em ${new Date(p.mtime).toLocaleDateString('pt-BR')}`)
          .join('\n');
      },
    },
  ],
};
