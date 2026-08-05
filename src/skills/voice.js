import { speak, listVoices } from '../voice/tts.js';
import { config } from '../core/config.js';

/**
 * Skill: controle da propria voz.
 *
 * Existe pro usuario poder mandar no JARVIS falando com ele — "fala mais
 * baixo", "cala a boca", "repete" — em vez de ter que mexer em .env.
 */

let lastReply = '';

export function setLastReply(text) {
  lastReply = text;
}

export default {
  name: 'voice',
  description: 'Controlar como o JARVIS fala e responde.',
  tools: [
    {
      name: 'set_speech',
      description:
        'Liga ou desliga a resposta falada. Use quando o usuario disser "para de falar", ' +
        '"fica quieto", "responde so no texto", "pode falar de novo".',
      input_schema: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean', description: 'true fala, false so escreve.' },
        },
        required: ['enabled'],
      },
      handler: async ({ enabled }) => {
        config.voice.speakReplies = enabled;
        return enabled ? 'Voltei a falar.' : 'Ok, so texto agora.';
      },
    },
    {
      name: 'repeat_last',
      description: 'Repete em voz alta a ultima coisa que eu disse. Use pra "repete", "nao entendi".',
      input_schema: { type: 'object', properties: {} },
      handler: async () => {
        if (!lastReply) return 'Ainda nao falei nada nesta sessao.';
        await speak(lastReply);
        return lastReply;
      },
    },
    {
      name: 'say',
      description:
        'Fala um texto especifico em voz alta. Use quando o usuario pedir pra eu ler algo ' +
        'ou anunciar alguma coisa.',
      input_schema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      handler: async ({ text }) => {
        await speak(text);
        return 'Falei.';
      },
    },
    {
      name: 'list_voices',
      description: 'Lista as vozes de sintese instaladas no Windows.',
      input_schema: { type: 'object', properties: {} },
      handler: async () => {
        const voices = await listVoices();
        return `Vozes instaladas:\n${voices}`;
      },
    },
    {
      name: 'set_wake_sensitivity',
      description:
        'Ajusta a sensibilidade da wake word (0 a 1). Mais alto detecta mais, mas dispara sozinho. ' +
        'Vale ate reiniciar o daemon.',
      input_schema: {
        type: 'object',
        properties: {
          sensitivity: { type: 'number', description: 'Entre 0 e 1. Padrao 0.6.' },
        },
        required: ['sensitivity'],
      },
      handler: async ({ sensitivity }) => {
        const value = Math.max(0, Math.min(1, sensitivity));
        config.voice.sensitivity = value;
        return (
          `Sensibilidade em ${value}. Vale depois de reiniciar a escuta — ` +
          `pra fixar, ponha JARVIS_WAKE_SENSITIVITY=${value} no .env.`
        );
      },
    },
  ],
};
