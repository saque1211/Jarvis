import { config } from '../core/config.js';

/**
 * Skill: integracoes externas que nao tem skill propria.
 *
 * Discord entra por webhook (o jeito honesto de um assistente pessoal mandar
 * mensagem sem se passar por bot logado). Casa inteligente entra por Home
 * Assistant, que ja fala com quase todo hardware — assim eu integro um
 * protocolo em vez de quinze marcas.
 */

async function homeAssistant(endpoint, options = {}) {
  if (!config.homeAssistant.baseUrl || !config.homeAssistant.token) {
    throw new Error('Falta HOME_ASSISTANT_URL e HOME_ASSISTANT_TOKEN no .env.');
  }
  const url = `${config.homeAssistant.baseUrl.replace(/\/$/, '')}/api${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${config.homeAssistant.token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  if (!res.ok) throw new Error(`Home Assistant ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export default {
  name: 'integrations',
  description: 'Discord, casa inteligente e outras APIs externas.',
  tools: [
    {
      name: 'discord_send',
      description:
        'Manda uma mensagem num canal do Discord via webhook. ' +
        'Use pra avisos e notificacoes que o usuario quer registrar num servidor.',
      input_schema: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Texto da mensagem.' },
          webhook_url: {
            type: 'string',
            description: 'Webhook especifico. Sem isso, usa DISCORD_WEBHOOK_URL do .env.',
          },
          username: { type: 'string', description: 'Nome exibido. Padrao: JARVIS.' },
        },
        required: ['message'],
      },
      handler: async ({ message, webhook_url, username = 'JARVIS' }) => {
        const url = webhook_url || config.discord.webhookUrl;
        if (!url) {
          return 'Falta DISCORD_WEBHOOK_URL no .env. Pegue em Config do canal > Integracoes > Webhooks.';
        }
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: message.slice(0, 2000), username }),
        });
        if (!res.ok) return `Discord ${res.status}: ${(await res.text()).slice(0, 200)}`;
        return 'Mensagem enviada no Discord.';
      },
    },
    {
      name: 'home_list_entities',
      description:
        'Lista os dispositivos da casa conectados ao Home Assistant. ' +
        'Filtre por dominio (light, switch, climate, sensor) ou por nome.',
      input_schema: {
        type: 'object',
        properties: {
          domain: {
            type: 'string',
            description: 'Ex: "light", "switch", "climate", "sensor".',
          },
          search: { type: 'string', description: 'Trecho do nome do dispositivo.' },
        },
      },
      handler: async ({ domain, search }) => {
        try {
          const states = await homeAssistant('/states');
          let entities = states;
          if (domain) entities = entities.filter((e) => e.entity_id.startsWith(`${domain}.`));
          if (search) {
            const q = search.toLowerCase();
            entities = entities.filter(
              (e) =>
                e.entity_id.toLowerCase().includes(q) ||
                e.attributes?.friendly_name?.toLowerCase().includes(q)
            );
          }
          if (!entities.length) return 'Nenhum dispositivo encontrado com esse filtro.';
          return entities
            .slice(0, 25)
            .map((e) => `${e.attributes?.friendly_name || e.entity_id}: ${e.state} [${e.entity_id}]`)
            .join('\n');
        } catch (err) {
          return err.message;
        }
      },
    },
    {
      name: 'home_control',
      description:
        'Liga, desliga ou ajusta um dispositivo da casa pelo Home Assistant. ' +
        'Use home_list_entities antes se nao souber o entity_id exato.',
      input_schema: {
        type: 'object',
        properties: {
          entity_id: { type: 'string', description: 'Ex: "light.sala", "switch.ventilador".' },
          action: { type: 'string', enum: ['turn_on', 'turn_off', 'toggle'] },
          brightness: { type: 'number', description: 'Brilho 0-255, so pra luzes.' },
          temperature: { type: 'number', description: 'Temperatura alvo, so pra climate.' },
        },
        required: ['entity_id', 'action'],
      },
      handler: async ({ entity_id, action, brightness, temperature }) => {
        const domain = entity_id.split('.')[0];
        const body = { entity_id };
        if (brightness != null) body.brightness = brightness;
        if (temperature != null) body.temperature = temperature;

        try {
          const service = temperature != null ? 'set_temperature' : action;
          await homeAssistant(`/services/${domain}/${service}`, {
            method: 'POST',
            body: JSON.stringify(body),
          });
          return `${entity_id}: ${action}.`;
        } catch (err) {
          return err.message;
        }
      },
    },
    {
      name: 'home_sensor_read',
      description:
        'Le um sensor da casa — temperatura, umidade, consumo. Aceita nome parcial.',
      input_schema: {
        type: 'object',
        properties: {
          sensor: { type: 'string', description: 'Nome ou entity_id do sensor.' },
        },
        required: ['sensor'],
      },
      handler: async ({ sensor }) => {
        try {
          const states = await homeAssistant('/states');
          const q = sensor.toLowerCase();
          const matches = states.filter(
            (e) =>
              e.entity_id.startsWith('sensor.') &&
              (e.entity_id.toLowerCase().includes(q) ||
                e.attributes?.friendly_name?.toLowerCase().includes(q))
          );
          if (!matches.length) return `Nenhum sensor com "${sensor}".`;
          return matches
            .slice(0, 5)
            .map(
              (e) =>
                `${e.attributes?.friendly_name || e.entity_id}: ${e.state}${e.attributes?.unit_of_measurement || ''}`
            )
            .join('\n');
        } catch (err) {
          return err.message;
        }
      },
    },
    {
      name: 'http_request',
      description:
        'Faz uma chamada HTTP arbitraria. Escape hatch pra qualquer API que ainda nao tem skill dedicada.',
      input_schema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
          headers: { type: 'object', description: 'Cabecalhos como pares chave-valor.' },
          body: { type: 'string', description: 'Corpo da requisicao, ja serializado.' },
        },
        required: ['url'],
      },
      handler: async ({ url, method = 'GET', headers = {}, body }) => {
        try {
          const res = await fetch(url, { method, headers, body });
          const text = await res.text();
          return `HTTP ${res.status}\n${text.slice(0, 4000)}`;
        } catch (err) {
          return `Requisicao falhou: ${err.message}`;
        }
      },
    },
  ],
};
