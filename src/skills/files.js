import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { config } from '../core/config.js';
import { startProcess } from '../platform/win32.js';

/**
 * Skill: gerenciar arquivos e pastas.
 *
 * Tudo passa por assertAllowed(). Por padrao o JARVIS so escreve dentro da
 * home do usuario e da raiz do projeto; JARVIS_ALLOWED_ROOTS amplia isso.
 * Isso evita que uma transcricao errada de voz vire um estrago em C:\Windows.
 */

function allowedRoots() {
  const roots = [os.homedir(), config.root, ...config.safety.allowedRoots];
  return roots.map((r) => path.resolve(r));
}

function assertAllowed(target, operation) {
  const resolved = path.resolve(expand(target));
  const ok = allowedRoots().some(
    (root) => resolved === root || resolved.startsWith(root + path.sep)
  );
  if (!ok) {
    throw new Error(
      `Bloqueado: "${resolved}" esta fora das pastas permitidas (${operation}). ` +
        `Permitidas: ${allowedRoots().join(', ')}. Amplie com JARVIS_ALLOWED_ROOTS no .env.`
    );
  }
  return resolved;
}

/** Expande ~, %USERPROFILE% e atalhos comuns em portugues. */
function expand(input) {
  let p = String(input).trim();
  const home = os.homedir();

  const shortcuts = {
    'downloads': path.join(home, 'Downloads'),
    'desktop': path.join(home, 'Desktop'),
    'area de trabalho': path.join(home, 'Desktop'),
    'documentos': path.join(home, 'Documents'),
    'documents': path.join(home, 'Documents'),
    'imagens': path.join(home, 'Pictures'),
    'pictures': path.join(home, 'Pictures'),
    'videos': path.join(home, 'Videos'),
    'musica': path.join(home, 'Music'),
  };

  const lower = p.toLowerCase();
  if (shortcuts[lower]) return shortcuts[lower];

  if (p.startsWith('~')) p = path.join(home, p.slice(1));
  p = p.replace(/%USERPROFILE%/gi, home);
  return p;
}

function human(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(1)} ${units[i]}`;
}

export default {
  name: 'files',
  // Controla a maquina local: so faz sentido onde ela esta. O servidor na
  // nuvem carrega o registro sem estas, e o agente do PC carrega so estas.
  platform: 'win32',
  description: 'Criar, mover, copiar, listar e organizar arquivos e pastas.',
  tools: [
    {
      name: 'list_directory',
      description: 'Lista o conteudo de uma pasta. Aceita atalhos como "downloads", "desktop".',
      input_schema: {
        type: 'object',
        properties: {
          directory: { type: 'string', description: 'Caminho ou atalho da pasta.' },
          pattern: { type: 'string', description: 'Filtro por extensao ou nome. Ex: ".pdf", "relatorio".' },
        },
        required: ['directory'],
      },
      handler: async ({ directory, pattern }) => {
        const dir = assertAllowed(directory, 'listar');
        if (!fs.existsSync(dir)) return `Pasta nao existe: ${dir}`;

        let entries = fs.readdirSync(dir, { withFileTypes: true });
        if (pattern) {
          const p = pattern.toLowerCase();
          entries = entries.filter((e) => e.name.toLowerCase().includes(p));
        }
        if (!entries.length) return `Nada encontrado em ${dir}.`;

        const lines = entries.slice(0, 100).map((e) => {
          if (e.isDirectory()) return `[pasta] ${e.name}`;
          const stat = fs.statSync(path.join(dir, e.name));
          return `${e.name} (${human(stat.size)})`;
        });
        const extra = entries.length > 100 ? `\n...e mais ${entries.length - 100}` : '';
        return `${dir} — ${entries.length} itens\n${lines.join('\n')}${extra}`;
      },
    },
    {
      name: 'create_folder',
      description: 'Cria uma pasta (e as pastas pai que faltarem).',
      input_schema: {
        type: 'object',
        properties: { directory: { type: 'string', description: 'Caminho da nova pasta.' } },
        required: ['directory'],
      },
      handler: async ({ directory }) => {
        const dir = assertAllowed(directory, 'criar pasta');
        fs.mkdirSync(dir, { recursive: true });
        return `Criei ${dir}.`;
      },
    },
    {
      name: 'move_file',
      description:
        'Move ou renomeia um arquivo/pasta. Nao sobrescreve destino existente a menos que overwrite=true.',
      input_schema: {
        type: 'object',
        properties: {
          source: { type: 'string' },
          destination: { type: 'string' },
          overwrite: { type: 'boolean', description: 'So use depois do usuario confirmar.' },
        },
        required: ['source', 'destination'],
      },
      handler: async ({ source, destination, overwrite }) => {
        const src = assertAllowed(source, 'mover');
        let dest = assertAllowed(destination, 'mover');
        if (!fs.existsSync(src)) return `Origem nao existe: ${src}`;

        // Destino sendo pasta: mantem o nome do arquivo.
        if (fs.existsSync(dest) && fs.statSync(dest).isDirectory()) {
          dest = path.join(dest, path.basename(src));
        }
        if (fs.existsSync(dest) && !overwrite) {
          return `Ja existe ${dest}. Pergunte ao usuario se pode sobrescrever, depois chame com overwrite=true.`;
        }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.renameSync(src, dest);
        return `Movi para ${dest}.`;
      },
    },
    {
      name: 'copy_file',
      description: 'Copia um arquivo ou pasta inteira.',
      input_schema: {
        type: 'object',
        properties: {
          source: { type: 'string' },
          destination: { type: 'string' },
        },
        required: ['source', 'destination'],
      },
      handler: async ({ source, destination }) => {
        const src = assertAllowed(source, 'copiar');
        const dest = assertAllowed(destination, 'copiar');
        if (!fs.existsSync(src)) return `Origem nao existe: ${src}`;
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.cpSync(src, dest, { recursive: true });
        return `Copiei para ${dest}.`;
      },
    },
    {
      name: 'delete_file',
      description:
        'Apaga um arquivo ou pasta. DESTRUTIVO — sempre pergunte ao usuario antes e so chame com confirmed=true.',
      input_schema: {
        type: 'object',
        properties: {
          target: { type: 'string' },
          confirmed: { type: 'boolean', description: 'true so apos o usuario aprovar em voz.' },
        },
        required: ['target'],
      },
      handler: async ({ target, confirmed }) => {
        if (!confirmed) return 'Nao apaguei nada. Confirme com o usuario e chame de novo com confirmed=true.';
        const full = assertAllowed(target, 'apagar');
        if (!fs.existsSync(full)) return `Nao existe: ${full}`;
        fs.rmSync(full, { recursive: true, force: true });
        return `Apaguei ${full}.`;
      },
    },
    {
      name: 'organize_folder',
      description:
        'Organiza uma pasta bagunçada movendo arquivos pra subpastas por tipo ' +
        '(Imagens, Videos, Documentos, Instaladores, Compactados, Codigo, Outros). ' +
        'Otimo pra Downloads. Use dry_run=true primeiro pra mostrar o plano.',
      input_schema: {
        type: 'object',
        properties: {
          directory: { type: 'string', description: 'Pasta a organizar. Ex: "downloads".' },
          dry_run: { type: 'boolean', description: 'true = so simula e relata o que faria.' },
        },
        required: ['directory'],
      },
      handler: async ({ directory, dry_run }) => {
        const dir = assertAllowed(directory, 'organizar');
        if (!fs.existsSync(dir)) return `Pasta nao existe: ${dir}`;

        const buckets = {
          Imagens: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.heic'],
          Videos: ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.wmv'],
          Audio: ['.mp3', '.wav', '.flac', '.ogg', '.m4a'],
          Documentos: ['.pdf', '.docx', '.doc', '.txt', '.md', '.xlsx', '.pptx', '.csv'],
          Instaladores: ['.exe', '.msi', '.appx'],
          Compactados: ['.zip', '.rar', '.7z', '.tar', '.gz'],
          Codigo: ['.js', '.ts', '.py', '.json', '.html', '.css', '.jsx', '.tsx', '.java', '.cs'],
        };

        const plan = [];
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isFile()) continue;
          const ext = path.extname(entry.name).toLowerCase();
          const bucket = Object.keys(buckets).find((b) => buckets[b].includes(ext)) || 'Outros';
          plan.push({ file: entry.name, bucket });
        }

        if (!plan.length) return `Nada pra organizar em ${dir}.`;

        if (dry_run) {
          const summary = plan.reduce((acc, p) => {
            acc[p.bucket] = (acc[p.bucket] || 0) + 1;
            return acc;
          }, {});
          const desc = Object.entries(summary).map(([b, n]) => `${n} pra ${b}`).join(', ');
          return `Plano para ${dir}: ${desc}. Confirme pra eu executar.`;
        }

        let moved = 0;
        for (const { file, bucket } of plan) {
          const destDir = path.join(dir, bucket);
          fs.mkdirSync(destDir, { recursive: true });
          let dest = path.join(destDir, file);
          // Colisao de nome: sufixa com contador em vez de sobrescrever.
          let n = 1;
          while (fs.existsSync(dest)) {
            const ext = path.extname(file);
            dest = path.join(destDir, `${path.basename(file, ext)} (${n++})${ext}`);
          }
          fs.renameSync(path.join(dir, file), dest);
          moved++;
        }
        return `Organizei ${moved} arquivos em ${dir}.`;
      },
    },
    {
      name: 'find_files',
      description: 'Procura arquivos por nome dentro de uma pasta, recursivamente.',
      input_schema: {
        type: 'object',
        properties: {
          directory: { type: 'string' },
          query: { type: 'string', description: 'Parte do nome do arquivo.' },
          max_depth: { type: 'number', description: 'Profundidade maxima. Padrao 4.' },
        },
        required: ['directory', 'query'],
      },
      handler: async ({ directory, query, max_depth = 4 }) => {
        const root = assertAllowed(directory, 'buscar');
        if (!fs.existsSync(root)) return `Pasta nao existe: ${root}`;
        const q = query.toLowerCase();
        const hits = [];

        const walk = (dir, depth) => {
          if (depth > max_depth || hits.length >= 50) return;
          let entries;
          try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
          } catch {
            return; // pasta sem permissao: pula em silencio
          }
          for (const entry of entries) {
            if (hits.length >= 50) return;
            const full = path.join(dir, entry.name);
            if (entry.name.toLowerCase().includes(q)) hits.push(full);
            if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
              walk(full, depth + 1);
            }
          }
        };
        walk(root, 0);

        if (!hits.length) return `Nenhum arquivo com "${query}" em ${root}.`;
        return `${hits.length} resultado(s):\n${hits.join('\n')}`;
      },
    },
    {
      name: 'open_in_explorer',
      description: 'Abre uma pasta no Explorer do Windows, ou seleciona um arquivo dentro dela.',
      input_schema: {
        type: 'object',
        properties: { target: { type: 'string', description: 'Pasta ou arquivo.' } },
        required: ['target'],
      },
      handler: async ({ target }) => {
        const full = assertAllowed(target, 'abrir');
        if (!fs.existsSync(full)) return `Nao existe: ${full}`;
        const isFile = fs.statSync(full).isFile();
        await startProcess('explorer.exe', isFile ? [`/select,${full}`] : [full]);
        return `Abri ${full} no Explorer.`;
      },
    },
  ],
};
