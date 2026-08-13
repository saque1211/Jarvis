import fs from 'node:fs';
import path from 'node:path';
import { config, ensureDirs } from './config.js';

/**
 * O vault e so arquivos markdown. Sem banco. Se nao esta no vault, nao
 * aconteceu — entao toda skill que produz algo duravel escreve aqui.
 */

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export function nowTime() {
  return new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

export function dailyFile(date = today()) {
  return path.join(config.vaultPath, 'daily', `${date}.md`);
}

/** Anexa uma entrada ao log do dia. */
export function appendDaily(section, body, date = today()) {
  ensureDirs();
  const file = dailyFile(date);
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `# ${date}\n`, 'utf8');
  }
  fs.appendFileSync(file, `\n## ${nowTime()} — ${section}\n\n${body}\n`, 'utf8');
  return file;
}

/** Escreve uma nota avulsa em vault/notes. */
export function writeNote(title, body) {
  ensureDirs();
  const slug = title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'nota';
  const file = path.join(config.vaultPath, 'notes', `${today()}-${slug}.md`);
  fs.writeFileSync(file, `# ${title}\n\n_${new Date().toISOString()}_\n\n${body}\n`, 'utf8');
  return file;
}

/** Le um arquivo do vault por caminho relativo. */
export function readVaultFile(relativePath) {
  const full = path.resolve(config.vaultPath, relativePath);
  if (!full.startsWith(config.vaultPath)) throw new Error('Caminho fora do vault.');
  if (!fs.existsSync(full)) return null;
  return fs.readFileSync(full, 'utf8');
}

/** Lista todos os arquivos .md do vault com mtime. */
export function listVaultFiles() {
  ensureDirs();
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.md')) {
        out.push({
          path: path.relative(config.vaultPath, full).replace(/\\/g, '/'),
          mtime: fs.statSync(full).mtimeMs,
        });
      }
    }
  };
  walk(config.vaultPath);
  return out.sort((a, b) => b.mtime - a.mtime);
}

/**
 * Busca full-text simples no vault. Sem indice — em alguns milhares de notas
 * isso ainda responde em milissegundos, e mantem o vault legivel por humano.
 */
export function searchVault(query, limit = 10) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const results = [];

  for (const { path: rel } of listVaultFiles()) {
    const content = readVaultFile(rel);
    if (!content) continue;
    const lower = content.toLowerCase();
    let score = 0;
    for (const term of terms) {
      const matches = lower.split(term).length - 1;
      score += matches;
    }
    if (score > 0) {
      const lines = content.split('\n');
      const hitLine = lines.findIndex((l) => terms.some((t) => l.toLowerCase().includes(t)));
      const excerpt = lines.slice(Math.max(0, hitLine - 1), hitLine + 4).join('\n');
      results.push({ path: rel, score, excerpt });
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Contexto curto do dia, injetado no system prompt do roteador. */
export function todayContext() {
  const file = dailyFile();
  if (!fs.existsSync(file)) return 'Nenhum registro hoje ainda.';
  const content = fs.readFileSync(file, 'utf8');

  // Esse texto entra no system prompt de TODA chamada, e o log do dia so
  // cresce — sem teto curto, o custo por comando aumenta ao longo do dia ate
  // estourar o limite por minuto do provedor. O modelo quase nunca precisa de
  // mais que os ultimos comandos; o resto ele busca com a skill memory.
  const limite = config.vaultContextChars;
  return content.length > limite ? `${content.slice(-limite)}\n[...truncado]` : content;
}
