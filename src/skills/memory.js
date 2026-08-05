import { searchVault, readVaultFile, listVaultFiles, appendDaily, writeNote, today } from '../core/vault.js';

/**
 * Skill: memoria (vault).
 *
 * Esta e a skill que faz o JARVIS ser SEU e nao um chatbot generico: ela le
 * o que ja aconteceu antes de responder. Tudo aqui e leitura/escrita de
 * markdown — voce consegue abrir o vault no Obsidian e entender tudo.
 */

export default {
  name: 'memory',
  description: 'Consultar e alimentar a memoria de longo prazo do JARVIS.',
  tools: [
    {
      name: 'search_memory',
      description:
        'Busca no vault por qualquer coisa que ja foi registrada. ' +
        'Use SEMPRE que o usuario perguntar sobre o passado: "o que eu fiz", ' +
        '"quando foi que", "qual era aquele", "lembra do".',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Termos de busca.' },
          limit: { type: 'number', description: 'Quantos resultados. Padrao 5.' },
        },
        required: ['query'],
      },
      handler: async ({ query, limit = 5 }) => {
        const results = searchVault(query, limit);
        if (!results.length) return `Nada no vault sobre "${query}".`;
        return results
          .map((r) => `--- ${r.path} ---\n${r.excerpt.slice(0, 800)}`)
          .join('\n\n');
      },
    },
    {
      name: 'read_memory_file',
      description: 'Le um arquivo especifico do vault, pelo caminho relativo que a busca devolveu.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Ex: "daily/2026-08-05.md".' },
        },
        required: ['path'],
      },
      handler: async ({ path: relativePath }) => {
        const content = readVaultFile(relativePath);
        if (content === null) return `Nao existe no vault: ${relativePath}`;
        return content.slice(0, 6000);
      },
    },
    {
      name: 'recent_activity',
      description:
        'Mostra o que foi registrado mais recentemente no vault. ' +
        'Use pra "o que eu andei fazendo", "resume minha semana".',
      input_schema: {
        type: 'object',
        properties: { limit: { type: 'number', description: 'Quantos arquivos. Padrao 7.' } },
      },
      handler: async ({ limit = 7 }) => {
        const files = listVaultFiles().slice(0, limit);
        if (!files.length) return 'Vault vazio ainda.';
        return files
          .map((f) => {
            const content = readVaultFile(f.path) || '';
            return `--- ${f.path} ---\n${content.slice(0, 700)}`;
          })
          .join('\n\n');
      },
    },
    {
      name: 'remember',
      speaks: true,
      description:
        'Grava um fato duravel sobre o usuario, um projeto ou uma pessoa. ' +
        'Use quando ele disser "lembra que", "sempre faca assim", "meu X e Y".',
      input_schema: {
        type: 'object',
        properties: {
          fact: { type: 'string', description: 'O fato a guardar, escrito de forma completa.' },
          topic: { type: 'string', description: 'Assunto/categoria. Ex: "preferencias", "projeto X".' },
        },
        required: ['fact'],
      },
      handler: async ({ fact, topic = 'geral' }) => {
        writeNote(`memoria — ${topic}`, fact);
        appendDaily('Memoria', `**${topic}:** ${fact}`);
        return 'Guardado.';
      },
    },
    {
      name: 'daily_summary',
      description:
        'Resume o dia: o que foi registrado no log de hoje. Use pra "fecha o dia", "como foi hoje".',
      input_schema: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Data YYYY-MM-DD. Padrao: hoje.' },
        },
      },
      handler: async ({ date = today() }) => {
        const content = readVaultFile(`daily/${date}.md`);
        if (!content) return `Nenhum registro em ${date}.`;
        return content.slice(0, 6000);
      },
    },
    {
      name: 'log_reflection',
      description: 'Registra a reflexao de fechamento do dia no vault.',
      input_schema: {
        type: 'object',
        properties: {
          went_well: { type: 'string', description: 'O que funcionou.' },
          to_improve: { type: 'string', description: 'O que melhorar.' },
          tomorrow: { type: 'string', description: 'O que fica pra amanha.' },
        },
        required: ['went_well'],
      },
      handler: async ({ went_well, to_improve, tomorrow }) => {
        const body = [
          `**Funcionou:** ${went_well}`,
          to_improve ? `**Melhorar:** ${to_improve}` : null,
          tomorrow ? `**Amanha:** ${tomorrow}` : null,
        ]
          .filter(Boolean)
          .join('\n\n');
        appendDaily('Fechamento do dia', body);
        return 'Dia fechado e registrado.';
      },
    },
  ],
};
