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
        // Falado, nao escrito: "20:40" a voz le "vinte dois pontos quarenta" ou
        // "vinte e quarenta", que soa errado. Em portugues se diz "oito e
        // quarenta da noite" — 12 horas + periodo do dia. Numeros como digitos
        // ("8 e 40") a voz ja pronuncia certo ("oito e quarenta").
        const fmt = new Intl.DateTimeFormat('pt-BR', {
          timeZone: FUSO, hour: '2-digit', minute: '2-digit', hour12: false,
        });
        const [hh, mm] = fmt.format(new Date()).split(':').map(Number);
        const periodo =
          hh < 5 ? 'da madrugada' : hh < 12 ? 'da manhã' : hh < 18 ? 'da tarde' : 'da noite';
        const h12 = hh % 12 || 12;
        if (mm === 0) return `Agora são ${h12} em ponto ${periodo}.`;
        if (mm === 30) return `Agora são ${h12} e meia ${periodo}.`;
        return `Agora são ${h12} e ${mm} ${periodo}.`;
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
