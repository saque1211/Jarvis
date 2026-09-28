import { lerSettings, gravarSettings, dentroDaJanela } from '../core/settings.js';
import { writeRuntime } from '../core/state.js';
import { calcular, localizar, configurado, emPalavras } from '../integrations/transito.js';

/**
 * Transito: quanto tempo leva pra chegar, e quanto disso e engarrafamento.
 *
 * O trajeto de casa pro trabalho e sempre o mesmo, e a pergunta tambem — por
 * isso os lugares tem NOME. "Quanto tempo ate o trabalho" tem que funcionar
 * sem ditar o endereco de novo toda manha, que e exatamente o que ninguem faz
 * falando com um painel do outro lado da sala.
 *
 * Um destino nao salvo ainda responde: ele e geocodificado na hora e nao fica
 * guardado. "Quanto tempo ate o aeroporto" nao deveria exigir cadastro.
 */

const semAcento = (s) =>
  String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

/** Casa o que foi falado com um lugar salvo. Tolerante de proposito: a fala
 *  vira "pro trabalho", "o trabalho", "trabalho" — tudo o mesmo lugar. */
export function acharLugar(lugares, texto) {
  const alvo = semAcento(texto);
  if (!alvo) return null;
  const exato = lugares.find((l) => semAcento(l.nome) === alvo);
  if (exato) return exato;
  return (
    lugares.find((l) => alvo.includes(semAcento(l.nome))) ||
    lugares.find((l) => semAcento(l.nome).includes(alvo)) ||
    null
  );
}

/**
 * Salvar/apagar lugar vive aqui, exportado, porque duas portas fazem a mesma
 * coisa: a voz ("meu trabalho e na avenida tal") e a tela dos Ajustes no
 * celular. Duplicar a regra daria dois lugares pra esquecer de normalizar o
 * nome — e aí "Trabalho" e "trabalho" virariam dois destinos.
 */
export async function definirOrigem(endereco) {
  const achado = await localizar(endereco);
  gravarSettings({
    transito: { origem: { nome: 'casa', endereco: achado.endereco, lat: achado.lat, lon: achado.lon } },
  });
  return achado;
}

export async function salvarLugar(nome, endereco, padrao = false) {
  const settings = lerSettings();
  const achado = await localizar(endereco, settings.transito.origem);
  const limpo = String(nome).trim();
  if (!limpo) throw new Error('Preciso de um nome pro lugar.');
  const lugar = { nome: limpo, endereco: achado.endereco, lat: achado.lat, lon: achado.lon };

  // Salvar de novo com o mesmo nome e correcao, nao duplicata: quem erra o
  // endereco falando repete a frase inteira.
  const lugares = settings.transito.lugares.filter((l) => semAcento(l.nome) !== semAcento(limpo));
  lugares.push(lugar);

  // Primeiro lugar salvo vira o padrao sozinho — quem tem um trajeto so nao
  // deveria ter que dizer qual e o principal.
  const ehPrimeiro = settings.transito.lugares.length === 0;
  gravarSettings({
    transito: { lugares, padrao: padrao || ehPrimeiro ? limpo : settings.transito.padrao },
  });
  return { lugar, antes: settings.transito };
}

export function apagarLugar(nome) {
  const settings = lerSettings();
  const alvo = acharLugar(settings.transito.lugares, nome);
  if (!alvo) return null;
  const lugares = settings.transito.lugares.filter((l) => l !== alvo);
  // Apagar o padrao sem eleger outro deixaria "como esta o transito" sem
  // resposta mesmo com lugares salvos na lista.
  const padrao = semAcento(settings.transito.padrao || '') === semAcento(alvo.nome)
    ? lugares[0]?.nome || null
    : settings.transito.padrao;
  gravarSettings({ transito: { lugares, padrao } });
  return alvo;
}

function origemOuAviso() {
  const { origem } = lerSettings().transito;
  if (origem.lat == null || origem.lon == null) {
    return {
      erro:
        'Nao sei de onde voce sai. Me diga o endereco de casa, tipo: ' +
        'minha casa e na rua Sete de Setembro, 120.',
    };
  }
  return { origem };
}

/** Resolve o destino: um lugar salvo, o padrao, ou um endereco novo na hora. */
async function resolverDestino(pedido, settings, origem) {
  const { lugares, padrao } = settings.transito;

  if (!pedido) {
    const alvo = (padrao && acharLugar(lugares, padrao)) || lugares[0];
    if (!alvo) {
      return {
        erro:
          'Pra onde? Diga o lugar, ou salve um: meu trabalho e na avenida tal, 400. ' +
          'Depois basta perguntar quanto tempo ate o trabalho.',
      };
    }
    return { destino: alvo, nome: alvo.nome };
  }

  const salvo = acharLugar(lugares, pedido);
  if (salvo) return { destino: salvo, nome: salvo.nome };

  const achado = await localizar(pedido, origem);
  return { destino: achado, nome: pedido };
}

/**
 * O que o indicador do painel de parede desenha, ou null pra ele sumir.
 *
 * Chamada de fora por quem serve o painel, de 5 em 5 minutos. Devolve null
 * fora da janela da manha SEM tocar na API: transito as 3 da madrugada e
 * enfeite, e cada consulta gasta cota de um trajeto que ninguem vai fazer.
 */
export async function paraOPainel(quando = new Date()) {
  const { transito } = lerSettings();
  if (!transito.noPainel || !configurado()) return null;
  if (!dentroDaJanela(transito.mostrarDe, transito.mostrarAte, quando)) return null;
  if (transito.origem.lat == null) return null;

  const alvo = acharLugar(transito.lugares, transito.padrao || '') || transito.lugares[0];
  if (!alvo) return null;

  const dados = await calcular(transito.origem, alvo);
  return {
    situacao: dados.situacao,
    minutos: dados.minutos,
    atrasoMin: dados.atrasoMin,
    destino: alvo.nome,
  };
}

/** O mesmo formato que a animacao consome, pra cena de quando alguem pergunta. */
function paraAnimacao(dados, destino) {
  return { situacao: dados.situacao, minutos: dados.minutos, atrasoMin: dados.atrasoMin, destino };
}

export default {
  name: 'transito',
  // So fala com a internet: vale no PC, no Raspberry e na nuvem.
  platform: '*',
  description: 'Tempo de trajeto e engarrafamento no caminho.',
  tools: [
    {
      name: 'get_traffic',
      speaks: true,
      description:
        'Diz quanto tempo leva pra chegar num lugar e quanto o transito esta atrasando. ' +
        'Use pra "como esta o transito", "quanto tempo ate o trabalho", "o transito esta ruim?", ' +
        '"da quanto tempo pra faculdade", "tem engarrafamento", "quanto tempo pro aeroporto". ' +
        'Aceita lugar salvo pelo nome ("trabalho") ou endereco qualquer. ' +
        'Sem destino, responde o lugar padrao — nao peca o endereco ao usuario antes de tentar.',
      input_schema: {
        type: 'object',
        properties: {
          destino: {
            type: 'string',
            description:
              'Nome do lugar salvo ("trabalho") ou endereco/lugar ("shopping do centro"). ' +
              'Deixe vazio pra usar o lugar padrao.',
          },
        },
      },
      handler: async ({ destino: pedido } = {}) => {
        if (!configurado()) {
          return 'O transito ainda nao esta configurado: falta a chave do TomTom no .env.';
        }
        const base = origemOuAviso();
        if (base.erro) return base.erro;

        try {
          const settings = lerSettings();
          const alvo = await resolverDestino(pedido, settings, base.origem);
          if (alvo.erro) return alvo.erro;
          const dados = await calcular(base.origem, alvo.destino);
          // Avisa o painel que o transito FOI PEDIDO agora — ele mostra o
          // indicador animado por alguns segundos, mesmo fora da janela da
          // manha. Mesma mecanica da cena do tempo.
          try {
            writeRuntime({ transitoPedido: { at: Date.now(), ...paraAnimacao(dados, alvo.nome) } });
          } catch {
            /* sem HUD/vault ele ainda fala a resposta normalmente */
          }
          return emPalavras(dados, alvo.nome);
        } catch (err) {
          return `Nao consegui ver o transito: ${err.message}`;
        }
      },
    },
    {
      name: 'set_traffic_origin',
      speaks: true,
      description:
        'Define de onde os trajetos saem — o endereco de casa. Use quando o usuario disser ' +
        'onde mora ou de onde sai: "minha casa e na rua tal, 120", "eu saio da avenida X". ' +
        'Precisa ser feito uma vez antes do transito funcionar.',
      input_schema: {
        type: 'object',
        properties: {
          endereco: { type: 'string', description: 'Endereco com rua e numero, e cidade se souber.' },
        },
        required: ['endereco'],
      },
      handler: async ({ endereco }) => {
        try {
          const achado = await definirOrigem(endereco);
          return `Pronto, seus trajetos saem de ${achado.endereco}.`;
        } catch (err) {
          return err.message;
        }
      },
    },
    {
      name: 'save_traffic_place',
      speaks: true,
      description:
        'Salva um lugar com nome pro transito, pra depois perguntar so pelo nome. Use pra ' +
        '"meu trabalho e na avenida tal", "salva a faculdade como sendo rua X", ' +
        '"guarda esse endereco como academia".',
      input_schema: {
        type: 'object',
        properties: {
          nome: { type: 'string', description: 'Como o usuario chama o lugar: "trabalho", "faculdade".' },
          endereco: { type: 'string', description: 'Endereco ou nome do lugar no mapa.' },
          padrao: {
            type: 'boolean',
            description: 'Marque quando for o trajeto do dia a dia — e o que responde "como esta o transito".',
          },
        },
        required: ['nome', 'endereco'],
      },
      handler: async ({ nome, endereco, padrao }) => {
        try {
          const { lugar, antes } = await salvarLugar(nome, endereco, padrao);
          if (antes.origem.lat == null) {
            return `Salvei ${lugar.nome} em ${lugar.endereco}. Agora me diga de onde voce sai.`;
          }
          const dados = await calcular(antes.origem, lugar);
          return `Salvei ${lugar.nome} em ${lugar.endereco}. ${emPalavras(dados, lugar.nome)}`;
        } catch (err) {
          return err.message;
        }
      },
    },
    {
      name: 'list_traffic_places',
      speaks: true,
      description:
        'Lista os lugares salvos do transito. Use pra "quais lugares voce tem salvo", ' +
        '"onde fica meu trabalho pra voce", "que enderecos voce sabe".',
      input_schema: { type: 'object', properties: {} },
      handler: async () => {
        const { origem, lugares, padrao } = lerSettings().transito;
        if (!lugares.length) {
          return origem.lat == null
            ? 'Nao tenho nenhum lugar salvo ainda, nem o seu endereco de casa.'
            : `Saio de ${origem.endereco}, mas nao tenho nenhum destino salvo.`;
        }
        const nomes = lugares.map((l) => (semAcento(l.nome) === semAcento(padrao || '') ? `${l.nome} (padrao)` : l.nome));
        return `Tenho ${nomes.join(', ')}.`;
      },
    },
    {
      name: 'remove_traffic_place',
      speaks: true,
      description:
        'Apaga um lugar salvo do transito. Use pra "esquece a faculdade", ' +
        '"tira a academia dos lugares".',
      input_schema: {
        type: 'object',
        properties: { nome: { type: 'string', description: 'Nome do lugar salvo.' } },
        required: ['nome'],
      },
      handler: async ({ nome }) => {
        const alvo = apagarLugar(nome);
        return alvo ? `Apaguei ${alvo.nome}.` : `Nao tenho nenhum lugar chamado ${nome}.`;
      },
    },
  ],
};
