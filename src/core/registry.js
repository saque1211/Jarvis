import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

// fileURLToPath, nao url.pathname — veja o comentario em config.js.
const SKILLS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills');

/**
 * Uma skill e um modulo que exporta { name, description, tools: [...] }.
 * Cada tool tem { name, description, input_schema, handler }.
 * O handler recebe (input, ctx) e devolve string ou objeto serializavel.
 *
 * Uma skill pode declarar `platform: 'win32'`. Sem isso, o JARVIS rodando num
 * servidor Linux ofereceria ao modelo tools que so funcionam no Windows — e
 * ele as escolheria, porque a descricao promete o que ele precisa. Errar assim
 * gasta uma ida ao modelo e devolve erro no lugar de resposta.
 *
 * `platform` do parametro permite montar o conjunto de OUTRA maquina: o
 * servidor precisa saber quais tools o agente do PC oferece pra rotear pra la.
 * `'*'` carrega tudo, ignorando a marcacao.
 */
export async function loadSkills({ platform = process.platform } = {}) {
  const skills = [];
  const files = fs
    .readdirSync(SKILLS_DIR)
    .filter((f) => f.endsWith('.js'))
    .sort();

  for (const file of files) {
    const mod = await import(pathToFileURL(path.join(SKILLS_DIR, file)).href);
    const skill = mod.default;
    if (!skill?.name || !Array.isArray(skill.tools)) {
      throw new Error(`Skill invalida em ${file}: precisa exportar default { name, tools[] }`);
    }
    if (platform !== '*' && skill.platform && skill.platform !== platform) continue;
    skills.push(skill);
  }

  return skills;
}

/** As skills que esta maquina NAO consegue rodar — o servidor delega ao agente. */
export async function skillsDeOutraPlataforma(platform) {
  const todas = await loadSkills({ platform: '*' });
  return todas.filter((s) => s.platform === platform && s.platform !== process.platform);
}

/** Achata as skills num mapa nome-da-tool -> { handler, skill }. */
export function buildToolIndex(skills) {
  const index = new Map();
  for (const skill of skills) {
    for (const tool of skill.tools) {
      if (index.has(tool.name)) {
        throw new Error(`Tool duplicada: "${tool.name}" (skill ${skill.name})`);
      }
      index.set(tool.name, { ...tool, skillName: skill.name });
    }
  }
  return index;
}

/**
 * Lista as tools sem o handler. Formato neutro — quem traduz pro wire format
 * de cada provedor e o src/core/llm.js.
 */
export function toolSpecs(skills) {
  const tools = [];
  for (const skill of skills) {
    for (const tool of skill.tools) {
      tools.push({
        name: tool.name,
        description: tool.description,
        input_schema: tool.input_schema,
      });
    }
  }
  return tools;
}
