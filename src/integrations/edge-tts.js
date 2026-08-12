import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { config } from '../core/config.js';

/**
 * Vozes neurais da Microsoft — as mesmas do "ler em voz alta" do Edge.
 *
 * Gratuitas, sem cadastro, sem chave. Em portugues sao muito melhores que
 * qualquer coisa local: o Piper e um modelo pequeno rodando no seu CPU, estas
 * rodam na infra da Microsoft.
 *
 * O preco: precisa de internet, e o texto da resposta sai da maquina (o audio
 * do microfone continua nunca saindo — isso e o Whisper, sempre local).
 *
 * AVISO: e o protocolo interno do Edge, nao uma API publica com contrato. Se a
 * Microsoft mudar, quebra — por isso a fala cai no TTS local quando falha.
 */

const TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const ENDPOINT = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
const LISTA = 'https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list';
const ORIGEM = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold';
// A versao acompanha um build real do Edge — o servico compara com o que ele
// espera, entao um numero inventado como "130.0.0.0" e recusado.
const VERSAO = '1-131.0.2903.112';
const AGENTE =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0';

// O servico compara o conjunto de cabecalhos com o que o Edge manda de fato;
// faltar um e motivo pra recusar o upgrade.
const CABECALHOS = {
  Origin: ORIGEM,
  'User-Agent': AGENTE,
  Pragma: 'no-cache',
  'Cache-Control': 'no-cache',
  'Accept-Encoding': 'gzip, deflate, br',
  'Accept-Language': 'en-US,en;q=0.9',
};

/** Id de conexao no formato deles: UUID sem hifens. */
const idConexao = () => crypto.randomUUID().replace(/-/g, '');

/**
 * O WebSocket nao conta por que falhou — o evento de erro nao carrega status.
 * Entao, quando ele cai, uma chamada HTTP ao mesmo servico com o mesmo token
 * responde a pergunta: e a rede, o token, ou o servico mudou?
 */
async function diagnosticar() {
  try {
    const res = await fetch(
      `${LISTA}?trustedclienttoken=${TOKEN}&Sec-MS-GEC=${gerarToken()}&Sec-MS-GEC-Version=${VERSAO}`,
      { headers: CABECALHOS, signal: AbortSignal.timeout(10000) }
    );
    if (res.ok) {
      return 'o servico responde, mas recusou a conexao de sintese — o protocolo pode ter mudado';
    }
    if (res.status === 401 || res.status === 403) {
      return (
        `recusado com ${res.status} — ou a Microsoft mudou a autenticacao, ` +
        'ou algo na sua rede (proxy, antivirus, firewall corporativo) esta barrando'
      );
    }
    return `o servico respondeu ${res.status}`;
  } catch (err) {
    if (err.name === 'TimeoutError') return 'o servico nao respondeu a tempo';
    return `nao alcancei o servico: ${err.message} (sem internet? firewall?)`;
  }
}

/**
 * O servico exige um token derivado do relogio, arredondado em janelas de 5
 * minutos. E ticks do Windows (100ns desde 1601) concatenados com a chave.
 */
function gerarToken() {
  const EPOCA_WINDOWS = 11644473600;
  let segundos = Math.floor(Date.now() / 1000) + EPOCA_WINDOWS;
  segundos -= segundos % 300;
  const ticks = segundos * 1e7;
  return crypto.createHash('sha256').update(`${ticks}${TOKEN}`).digest('hex').toUpperCase();
}

function ssml(texto, voz, taxa, volume) {
  const escapado = texto
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  return (
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='pt-BR'>` +
    `<voice name='${voz}'>` +
    `<prosody rate='${taxa}' pitch='+0Hz' volume='${volume}'>${escapado}</prosody>` +
    `</voice></speak>`
  );
}

/**
 * O formato de data que o Edge manda — nao e ISO. E o toString() do JavaScript
 * em UTC, porque do outro lado o cliente original e um navegador.
 */
function dataProtocolo() {
  const d = new Date();
  const dias = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const meses = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${dias[d.getUTCDay()]} ${meses[d.getUTCMonth()]} ${p(d.getUTCDate())} ${d.getUTCFullYear()} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} ` +
    `GMT+0000 (Coordinated Universal Time)`
  );
}

/** Cabecalho no formato do protocolo: "Chave:valor\r\n" repetido, depois \r\n. */
function mensagem(cabecalhos, corpo = '') {
  const linhas = Object.entries(cabecalhos).map(([k, v]) => `${k}:${v}`);
  return `${linhas.join('\r\n')}\r\n\r\n${corpo}`;
}

export function isConfigured() {
  return Boolean(config.edgeTts.voice);
}

/**
 * Sintetiza e devolve o caminho de um WAV. Pede PCM 16 bits direto, entao nao
 * precisa converter nada depois — o SoundPlayer do Windows toca isso nativo.
 */
export async function synthesize(text, opcoes = {}) {
  // `opcoes.voice` existe pro script de audicao, que precisa falar com cada voz
  // sem mexer no .env — o objetivo dele e justamente escolher qual por la.
  const { voice, rate, volume } = { ...config.edgeTts, ...opcoes };
  if (!voice) throw new Error('Falta EDGE_TTS_VOICE no .env.');

  // Um id por conexao. Sem ele o servico aceita o token mas recusa o upgrade —
  // foi exatamente o sintoma: a lista de vozes respondia, a sintese nao.
  const conexao = idConexao();

  const url =
    `${ENDPOINT}?TrustedClientToken=${TOKEN}` +
    `&Sec-MS-GEC=${gerarToken()}` +
    `&Sec-MS-GEC-Version=${VERSAO}` +
    `&ConnectionId=${conexao}`;

  const pedacos = [];

  await new Promise((resolve, reject) => {
    let socket;
    try {
      socket = new WebSocket(url, { headers: CABECALHOS });
    } catch (err) {
      reject(new Error(`nao consegui abrir a conexao: ${err.message}`));
      return;
    }

    socket.binaryType = 'arraybuffer';

    const prazo = setTimeout(() => {
      try {
        socket.close();
      } catch {
        // Ja caiu.
      }
      reject(new Error('o servico nao respondeu em 20s'));
    }, 20000);

    const encerrar = (err) => {
      clearTimeout(prazo);
      try {
        socket.close();
      } catch {
        // Ja caiu.
      }
      err ? reject(err) : resolve();
    };

    socket.onopen = () => {
      socket.send(
        mensagem(
          {
            'X-Timestamp': dataProtocolo(),
            'Content-Type': 'application/json; charset=utf-8',
            Path: 'speech.config',
          },
          JSON.stringify({
            context: {
              synthesis: {
                audio: {
                  metadataoptions: { sentenceBoundaryEnabled: false, wordBoundaryEnabled: false },
                  // WAV cru: o Windows toca sem conversor, e o navegador do
                  // celular tambem.
                  outputFormat: 'riff-24khz-16bit-mono-pcm',
                },
              },
            },
          })
        )
      );

      socket.send(
        mensagem(
          {
            'X-RequestId': crypto.randomUUID().replace(/-/g, ''),
            'Content-Type': 'application/ssml+xml',
            'X-Timestamp': dataProtocolo(),
            Path: 'ssml',
          },
          ssml(text, voice, rate, volume)
        )
      );
    };

    socket.onmessage = (evento) => {
      if (typeof evento.data === 'string') {
        if (evento.data.includes('Path:turn.end')) encerrar();
        return;
      }

      // Binario: 2 bytes de tamanho do cabecalho, o cabecalho, e o audio.
      const buffer = Buffer.from(evento.data);
      const tamanho = buffer.readUInt16BE(0);
      const cabecalho = buffer.subarray(2, 2 + tamanho).toString();
      if (cabecalho.includes('Path:audio')) {
        pedacos.push(buffer.subarray(2 + tamanho));
      }
    };

    let jaFalhou = false;
    const falhar = async (resumo) => {
      if (jaFalhou) return;
      jaFalhou = true;
      const motivo = await diagnosticar();
      encerrar(new Error(`${resumo} — ${motivo}`));
    };

    socket.onerror = () => falhar('a conexao de voz caiu');

    socket.onclose = (evento) => {
      if (pedacos.length) encerrar();
      else falhar(`a conexao fechou sem audio (codigo ${evento.code})`);
    };
  });

  if (!pedacos.length) throw new Error('nenhum audio recebido');

  const out = path.join(os.tmpdir(), `jarvis-edge-${Date.now()}.wav`);
  fs.writeFileSync(out, Buffer.concat(pedacos));
  return out;
}
