/**
 * Que horas sao, que dia e hoje.
 *
 * Existe porque na nuvem nao havia como responder "que horas sao": o relogio
 * do HUD e coisa de tela, nao uma tool. Sem esta, o modelo pequeno (Haiku)
 * chutava a tool `say` do voice e respondia "Falei." — a bomba classica de
 * nao ter a ferramenta certa pra uma pergunta obvia.
 *
 * `platform: '*'` de proposito: hora e data valem em qualquer maquina, e esta
 * e uma das poucas que precisam rodar na nuvem (onde nao ha as tools de PC).
 *
 * O fuso e America/Sao_Paulo por padrao porque o servidor roda em UTC — sem
 * fixar, "que horas sao" responderia a hora de Londres. JARVIS_TZ troca isso.
 */

const FUSO = process.env.JARVIS_TZ || 'America/Sao_Paulo';

export default {
  name: 'relogio',
  platform: '*',
  description: 'Que horas são e que dia é hoje.',
  tools: [
    {
      name: 'get_time',
      speaks: true,
      description:
        'Diz a hora atual. Use pra "que horas são", "me diz as horas", "que horas ' +
        'que são agora". NAO use a tool say pra isso — say só repete um texto; esta ' +
        'sabe a hora de verdade.',
      input_schema: { type: 'object', properties: {} },
      handler: async () => {
        const hora = new Date().toLocaleTimeString('pt-BR', {
          timeZone: FUSO,
          hour: '2-digit',
          minute: '2-digit',
        });
        return `Agora são ${hora}.`;
      },
    },
    {
      name: 'get_date',
      speaks: true,
      description:
        'Diz a data de hoje. Use pra "que dia é hoje", "qual a data", "que dia da ' +
        'semana é hoje".',
      input_schema: { type: 'object', properties: {} },
      handler: async () => {
        const hoje = new Date().toLocaleDateString('pt-BR', {
          timeZone: FUSO,
          weekday: 'long',
          day: 'numeric',
          month: 'long',
        });
        return `Hoje é ${hoje}.`;
      },
    },
  ],
};
