import { criar, remover, concluir, listar, pendentes, emPalavras, nomeDoDia } from '../core/avisos.js';

/**
 * Avisos com janela de horario — a coisa que o HUD mostra no card de cima.
 *
 * Separado do `notify` de proposito: la o lembrete e um instante ("me avisa as
 * 15h"), aqui e um estado que dura ("ainda falta tirar o lixo"). Sao dois jeitos
 * diferentes de esquecer as coisas e precisam de dois jeitos de lembrar.
 */

export default {
  name: 'avisos',
  platform: '*',
  description: 'Avisos que se repetem toda semana e ficam na tela ate voce dizer que fez.',
  tools: [
    {
      name: 'create_weekly_reminder',
      speaks: true,
      description:
        'Cria um aviso que se repete toda semana e fica visivel numa faixa de horario. ' +
        'Use pra "toda quinta me lembra de tirar o lixo", "me avisa de tomar remedio de manha ' +
        'todo dia", "segunda e quarta tem academia". Diferente de set_reminder, que dispara uma ' +
        'vez num horario exato — este fica pendente ate ser concluido.',
      input_schema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'O que fazer. Ex: "tirar o lixo".' },
          days: {
            type: 'array',
            items: { type: 'string' },
            description: 'Dias da semana por extenso: ["quinta"] ou ["segunda","quarta"].',
          },
          from: { type: 'string', description: 'Inicio da janela, formato 08:00. Padrao 08:00.' },
          to: { type: 'string', description: 'Fim da janela, formato 21:00. Padrao 21:00.' },
        },
        required: ['text', 'days'],
      },
      handler: async ({ text, days, from = '08:00', to = '21:00' }) => {
        try {
          const a = criar({ texto: text, dias: days, de: from, ate: to });
          const quando = a.dias.map(nomeDoDia).join(' e ');
          return `Combinado: ${a.texto}, toda ${quando}, das ${a.de} as ${a.ate}.`;
        } catch (err) {
          return err.message;
        }
      },
    },
    {
      name: 'list_weekly_reminders',
      speaks: true,
      description:
        'Lista os avisos semanais cadastrados. Use pra "quais avisos eu tenho", ' +
        '"o que voce me lembra toda semana".',
      input_schema: { type: 'object', properties: {} },
      handler: async () => {
        const todos = listar();
        if (!todos.length) return 'Nenhum aviso cadastrado.';
        return todos
          .map((a) => `${a.texto}, ${a.dias.map(nomeDoDia).join(' e ')}, das ${a.de} as ${a.ate}`)
          .join('. ');
      },
    },
    {
      name: 'whats_pending',
      speaks: true,
      description:
        'Diz o que ainda falta fazer agora. Use pra "o que falta hoje", "tem alguma coisa ' +
        'pendente", "o que eu tenho que fazer".',
      input_schema: { type: 'object', properties: {} },
      handler: async () => emPalavras(),
    },
    {
      name: 'complete_reminder',
      speaks: true,
      description:
        'Marca um aviso semanal como feito hoje — ele some da tela e volta na proxima ' +
        'semana. So use quando a frase citar QUAL aviso: "ja tirei o lixo", "tomei o ' +
        'remedio", "pode tirar o lixo da tela". Um "feito" ou "ja fiz" solto, sem dizer ' +
        'o que, NAO e este — pergunte qual antes.',
      input_schema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Parte do texto do aviso. Ex: "lixo".' },
        },
        required: ['text'],
      },
      handler: async ({ text }) => {
        const alvo = pendentes().find((a) =>
          a.texto.toLowerCase().includes(String(text).toLowerCase())
        );
        if (!alvo) return `Nao achei nenhum aviso pendente com "${text}".`;
        concluir(alvo.id);
        return `Pronto, ${alvo.texto} marcado como feito.`;
      },
    },
    {
      name: 'delete_weekly_reminder',
      speaks: true,
      description:
        'Apaga um aviso semanal de vez. Use pra "para de me lembrar do lixo", ' +
        '"tira o aviso da academia". Diferente de complete_reminder, que so vale pra hoje.',
      input_schema: {
        type: 'object',
        properties: { text: { type: 'string', description: 'Parte do texto do aviso.' } },
        required: ['text'],
      },
      handler: async ({ text }) => {
        const alvo = listar().find((a) => a.texto.toLowerCase().includes(String(text).toLowerCase()));
        if (!alvo) return `Nao achei nenhum aviso com "${text}".`;
        remover(alvo.id);
        return `Apaguei o aviso de ${alvo.texto}.`;
      },
    },
  ],
};
