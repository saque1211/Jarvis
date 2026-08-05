import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SKILLS_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'skills');

/**
 * Uma skill e um modulo que exporta { name, description, tools: [...] }.
 * Cada tool tem { name, description, input_schema, handler }.
 * O handler recebe (input, ctx) e devolve string ou objeto serializavel.
 */
export async function loadSkills() {
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
    skills.push(skill);
  }

  return skills;
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

/** Converte pro formato que a API do Claude espera (sem o handler). */
export function toAnthropicTools(skills) {
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
