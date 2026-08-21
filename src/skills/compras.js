import { lerSettings, gravarSettings } from '../core/settings.js';

/**
 * Lista de compras.
 *
 * Vive nas preferencias e nao no vault por um motivo pratico: e a lista que o
 * celular abre no mercado. Tem que ser a mesma coisa que a voz da cozinha
 * escreveu cinco minutos antes, sem sincronizacao nenhuma no meio.
 */

function normalizar(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
}

export function listarCompras() {
  return lerSettings().compras;
}

/**
 * Acrescenta sem duplicar. "poe leite" duas vezes e o caso NORMAL — voce
 * lembra de novo no corredor —, e ver "leite, leite" na lista faz voce comprar
 * dois.
 */
export function adicionar(itens) {
  const atual = listarCompras();
  const vistos = new Set(atual.map((i) => normalizar(i.nome)));
  const novos = [];

  for (const bruto of Array.isArray(itens) ? itens : [itens]) {
    const nome = String(bruto || '').trim();
    if (!nome || vistos.has(normalizar(nome))) continue;
    vistos.add(normalizar(nome));
    novos.push({ nome, feito: false, em: new Date().toISOString() });
  }

  if (novos.length) gravarSettings({ compras: [...atual, ...novos] });
  return novos;
}

export function marcar(nome, feito = true) {
  const atual = listarCompras();
  const alvo = atual.find((i) => normalizar(i.nome).includes(normalizar(nome)));
  if (!alvo) return null;
  gravarSettings({
    compras: atual.map((i) => (i === alvo ? { ...i, feito } : i)),
  });
  return alvo;
}

export function remover(nome) {
  const atual = listarCompras();
  const alvo = atual.find((i) => normalizar(i.nome).includes(normalizar(nome)));
  if (!alvo) return null;
  gravarSettings({ compras: atual.filter((i) => i !== alvo) });
  return alvo;
}

/** Tira os riscados. E o que voce faz ao chegar em casa do mercado. */
export function limparFeitos() {
  const atual = listarCompras();
  const restam = atual.filter((i) => !i.feito);
  gravarSettings({ compras: restam });
  return atual.length - restam.length;
}

export default {
  name: 'compras',
  platform: '*',
  description: 'Lista de compras compartilhada entre a voz e o celular.',
  tools: [
    {
      name: 'add_to_shopping_list',
      speaks: true,
      description:
        'Poe itens na lista de compras. Use pra "poe leite na lista", "adiciona arroz e feijao ' +
        'nas compras", "anota papel higienico", "acabou o cafe". Aceita varios de uma vez.',
      input_schema: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: { type: 'string' },
            description: 'Os itens. Ex: ["leite", "pao"].',
          },
        },
        required: ['items'],
      },
      handler: async ({ items }) => {
        const novos = adicionar(items);
        if (!novos.length) return 'Isso ja esta na lista.';
        if (novos.length === 1) return `Anotei ${novos[0].nome}.`;
        return `Anotei ${novos.length} itens: ${novos.map((i) => i.nome).join(', ')}.`;
      },
    },
    {
      name: 'read_shopping_list',
      speaks: true,
      description:
        'Le a lista de compras. Use pra "o que tem na lista", "le as compras", ' +
        '"o que eu preciso comprar".',
      input_schema: { type: 'object', properties: {} },
      handler: async () => {
        const faltam = listarCompras().filter((i) => !i.feito);
        if (!faltam.length) return 'A lista de compras esta vazia.';
        const nomes = faltam.map((i) => i.nome);
        if (nomes.length === 1) return `So ${nomes[0]}.`;
        return `${nomes.length} itens: ${nomes.slice(0, -1).join(', ')} e ${nomes.at(-1)}.`;
      },
    },
    {
      name: 'remove_from_shopping_list',
      speaks: true,
      description:
        'Tira um item da lista de compras. Use pra "tira o leite da lista", "ja comprei o arroz", ' +
        '"risca o pao".',
      input_schema: {
        type: 'object',
        properties: { item: { type: 'string', description: 'O item. Ex: "leite".' } },
        required: ['item'],
      },
      handler: async ({ item }) => {
        const alvo = remover(item);
        return alvo ? `Tirei ${alvo.nome} da lista.` : `Nao achei "${item}" na lista.`;
      },
    },
  ],
};
