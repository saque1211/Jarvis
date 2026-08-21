import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { run } from '../platform/win32.js';
import { config } from '../core/config.js';

/**
 * Transcricao local. O audio nao sai da maquina.
 *
 * Estrategia: STT_COMMAND no .env manda em tudo. Sem ele, tenta o whisper.cpp
 * (whisper-cli) e depois o pacote openai-whisper do Python — os dois rodam
 * offline. Se nenhum existir, dizemos claramente o que instalar em vez de
 * mandar o audio pra nuvem por conta propria.
 */

/**
 * Vocabulario que o whisper recebe como "prompt inicial". Ele nao obriga nada:
 * serve de desempate quando o audio e ambiguo. Sem isso "abre o VS Code" vira
 * "abre o vesse code", e "Workana" vira qualquer coisa.
 *
 * O ganho grande vem dos nomes que SO existem nesta maquina — os apps que voce
 * cadastrou. Um vocabulario generico ajuda pouco; o seu ajuda muito.
 */
function nomeBonito() {
  const nome = String(config.voice.wakeWord || '').trim();
  return nome ? nome.charAt(0).toUpperCase() + nome.slice(1) : '';
}

/** O texto ja menciona a palavra de ativacao? */
function citaONome(texto) {
  const nome = String(config.voice.wakeWord || '').trim();
  if (!nome) return true;
  const escapado = nome.replace(/[.*+?^${}()|[\]\\]/g, (m) => '\\' + m);
  return new RegExp('\\b' + escapado + '\\b', 'i').test(String(texto || ''));
}

/**
 * O STT_PROMPT do usuario nomeia OUTRO assistente?
 *
 * Vale um aviso alto: um prompt que diz "Jarvis" enquanto a palavra de
 * ativacao e "vexis" ensina o whisper a escrever o nome errado justamente na
 * palavra que decide se ele acorda. Sobra de quando o assistente tinha outro
 * nome, e nada no comportamento aponta pra la.
 */
export function conflitoDeNomeNoPrompt() {
  const doUsuario = config.voice.sttPrompt ? String(config.voice.sttPrompt) : '';
  if (!doUsuario || citaONome(doUsuario)) return null;
  const outro = /\b(jarvis|alexa|siri|google|cortana|assistente\s+\w+)\b/i.exec(doUsuario);
  return outro ? outro[1] : null;
}

/**
 * A frase de abertura do prompt inicial, com o nome do assistente dentro.
 *
 * O nome precisa aparecer porque, na escuta continua, e a transcricao dele que
 * decide se o assistente acorda — e "vexis" nao existe em portugues.
 *
 * Mas aparece UMA vez, dentro de uma frase normal. Repetir ("Vexis. Ei Vexis.
 * Vexis,") foi o que quebrou tudo: o prompt inicial do whisper e contexto
 * anterior, e contexto repetitivo faz ele repetir e alucinar. O nome ficava
 * mais provavel e todo o RESTO ficava pior — e o resto e o comando.
 *
 * A frase tambem existe pra dizer ao whisper que dominio e este. Sem ela, ele
 * transcreve como se fosse conversa solta.
 */
function aberturaDoPrompt() {
  const nome = String(config.voice.wakeWord || '').trim();
  if (!nome) return 'Comandos para o assistente.';
  const bonito = nome.charAt(0).toUpperCase() + nome.slice(1);
  return `Comandos para o assistente ${bonito}.`;
}

const VOCAB_BASE =
  'Abrir, fechar, iniciar, parar, tocar, pausar, pular, aumentar, diminuir. ' +
  'Timer, pomodoro, cronometro, lembrete, tarefa, anotacao. ' +
  'CPU, RAM, GPU, disco, bateria, volume, brilho, monitor. ' +
  'Screenshot, gravar tela, area de transferencia. ' +
  'Commit, push, branch, build, deploy, terminal, projeto.';

/**
 * Nomes de app cadastrados — a parte do vocabulario que e so sua.
 *
 * Um alvo tem varios apelidos, e alguns existem de proposito ERRADOS: "cromo",
 * "espotifai", "uatsap" servem pro resolvedor entender voz torta. Mandar essas
 * grafias pro whisper faz o contrario do que queremos — ensina ele a ESCREVER
 * "espotifai". Entao aqui sai um nome por alvo, e o escolhido e o que parece
 * nome de verdade: aquele que aparece dentro do proprio alvo
 * ("spotify" esta em "spotify:", "cromo" nao esta em "chrome").
 */
export function nomesDeApps() {
  let apps;
  try {
    apps = JSON.parse(fs.readFileSync(config.paths.apps, 'utf8'));
  } catch {
    return [];
  }

  const simples = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const porAlvo = new Map();

  for (const [apelido, alvo] of Object.entries(apps)) {
    const chave = String(alvo).toLowerCase();
    const pareceNome = simples(chave).includes(simples(apelido));
    const atual = porAlvo.get(chave);
    // Entre dois candidatos "de verdade", o mais curto e o que a pessoa fala.
    if (!atual || (pareceNome && !atual.pareceNome) ||
        (pareceNome === atual.pareceNome && apelido.length < atual.apelido.length)) {
      porAlvo.set(chave, { apelido, pareceNome });
    }
  }

  return [...porAlvo.values()].map((e) => e.apelido);
}

/**
 * Um STT_PROMPT com pedaco de linha de comando colado (aconteceu: o
 * .env.example tinha duas linhas grudadas) faz o whisper transcrever fragmentos
 * do proprio comando. Tira o que tem cara de flag, caminho ou executavel.
 */
export function limparPrompt(texto) {
  // Nao adianta tirar pedaco por pedaco: o que sobra sao restos ("pt" de
  // "-l pt") que o whisper trata como vocabulario. Como o defeito e sempre uma
  // linha de comando colada NO FIM, o certo e cortar dali pra frente.
  const inicioDoComando = texto.search(
    /whisper|piper|ffmpeg|\s-{1,2}[a-z]|[\\/][\w.-]+\.(bin|exe|onnx)/i
  );
  const limpo = inicioDoComando >= 0 ? texto.slice(0, inicioDoComando) : texto;
  return limpo.replace(/\{\w+\}/g, '').replace(/\s{2,}/g, ' ').trim();
}

/**
 * Monta o prompt inicial do whisper. O limite util e ~224 tokens: passando
 * disso ele corta, e prompt cortado no meio atrapalha mais do que ajuda.
 */
/**
 * Nome que alguem fala em voz alta, e nao entrada de instalador. Depois do
 * apps:find o registro enche de "microsoft visual c++ 2015 redistributable" e
 * "nvidia control panel 3d" — ninguem pede isso falando, e cada um desses
 * empurra pra fora do prompt um nome que voce usa de verdade.
 */
function faladoPorGente(nome) {
  if (nome.length > 22) return false;
  if (nome.split(/\s+/).length > 3) return false;
  // Versao, arquitetura, ano: marca de entrada tecnica.
  if (/\d{2,}|x64|x86|32.?bit|64.?bit|redistribut|runtime|sdk|driver/i.test(nome)) return false;
  return true;
}

// Teto do prompt inicial do whisper (~224 tokens). Passando disso ele corta
// sozinho, e corte no meio de um nome ensina o nome errado.
const TETO = 900;
// Reserva pro vocabulario de comandos. Sem isso uma lista grande de apps come
// o prompt inteiro, e some justamente "pomodoro", "cronometro", "screenshot" —
// as palavras que o whisper mais erra e que a lista existe pra proteger.
const RESERVA_COMANDOS = 380;

export function promptDeVocabulario() {
  const partes = [];
  const doUsuario = config.voice.sttPrompt ? limparPrompt(config.voice.sttPrompt) : '';

  if (doUsuario) {
    // O STT_PROMPT do usuario JA e o enquadramento. Empilhar o meu em cima
    // produzia isto, visto no uso real:
    //
    //   "Comandos para o assistente Vexis. Comandos para o assistente Jarvis: ..."
    //
    // Duas aberturas seguidas — o padrao repetitivo que degrada o whisper — e
    // ainda por cima nomeando dois assistentes diferentes. Quando o prompt dele
    // ja cita o nome, o meu nao entra; quando nao cita, entra so o NOME, uma
    // palavra, sem uma segunda frase de enquadramento.
    if (!citaONome(doUsuario)) partes.push(`${nomeBonito()}.`);
    partes.push(doUsuario);
  } else {
    partes.push(aberturaDoPrompt());
  }

  // Nomes curtos primeiro: sao os mais provaveis de serem falados, e cabem
  // mais deles no espaco que sobrar.
  const apps = nomesDeApps()
    .filter(faladoPorGente)
    .sort((a, b) => a.length - b.length);

  const espacoDeApps = TETO - RESERVA_COMANDOS - partes.join(' ').length - 20;
  const cabem = [];
  let usado = 0;
  for (const app of apps) {
    if (usado + app.length + 2 > espacoDeApps) break;
    cabem.push(app);
    usado += app.length + 2;
  }
  if (cabem.length) partes.push(`Aplicativos: ${cabem.join(', ')}.`);

  partes.push(VOCAB_BASE);

  const texto = partes.join(' ');
  if (texto.length <= TETO) return texto;
  // Corta em fronteira de palavra — metade de um nome ensina o nome errado.
  return texto.slice(0, TETO).replace(/\s\S*$/, '');
}

const CANDIDATES = [
  {
    name: 'whisper.cpp',
    bin: 'whisper-cli',
    args: (wav, model) => [
      '-m', model || process.env.WHISPER_MODEL || 'models/ggml-base.bin',
      '-f', wav,
      '-l', 'pt',
      '-nt',       // sem timestamps
      '--no-prints',
    ],
    parse: (stdout) => stdout.trim(),
  },
  {
    name: 'whisper (python)',
    bin: 'whisper',
    args: (wav) => [wav, '--language', 'Portuguese', '--model', process.env.WHISPER_MODEL || 'base', '--output_format', 'txt', '--output_dir', os.tmpdir(), '--fp16', 'False'],
    parse: (stdout, wav) => {
      const txt = path.join(os.tmpdir(), `${path.basename(wav, '.wav')}.txt`);
      if (fs.existsSync(txt)) {
        const text = fs.readFileSync(txt, 'utf8').trim();
        fs.rmSync(txt, { force: true });
        return text;
      }
      // O CLI tambem imprime a transcricao com timestamps na frente.
      return stdout.replace(/\[[\d:.\s\->]+\]/g, '').trim();
    },
  },
];

/**
 * Quebra o STT_COMMAND em argumentos respeitando aspas — "C:/Program Files/x.exe"
 * e um argumento so. Sem isso, qualquer caminho com espaco vira lixo.
 */
function tokenize(command) {
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = re.exec(command)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

let resolved = null;

/**
 * Fala com o whisper-server (whisper.cpp em modo HTTP). A vantagem sobre o
 * whisper-cli nao e a rede — e o modelo ficar carregado entre um comando e
 * outro, em vez de subir do disco toda vez.
 */
async function transcribeViaServer(wavPath) {
  const url = config.voice.sttServerUrl.replace(/\/$/, '');
  const form = new FormData();
  // O type vira o Content-Type da parte. O parser multipart do whisper.cpp
  // depende dele pra reconhecer o anexo como audio.
  const blob = new Blob([fs.readFileSync(wavPath)], { type: 'audio/wav' });
  form.append('file', blob, path.basename(wavPath));
  form.append('response_format', 'json');
  form.append('language', 'pt');
  form.append('prompt', promptDeVocabulario());

  let response;
  try {
    response = await fetch(`${url}/inference`, {
      method: 'POST',
      body: form,
      // Sem prazo, um servidor que aceita a conexao e nao responde trava o
      // daemon pra sempre — sem erro, sem log, so parado.
      signal: AbortSignal.timeout(config.voice.sttTimeoutMs),
    });
  } catch (err) {
    const motivo =
      err.name === 'TimeoutError'
        ? `nao respondeu em ${config.voice.sttTimeoutMs / 1000}s`
        : err.message;
    throw new Error(
      `whisper-server em ${url}: ${motivo}\n` +
        'Ele esta rodando? O daemon sobe sozinho no boot; se falhou, veja o log [whisper].'
    );
  }

  if (!response.ok) {
    throw new Error(`whisper-server respondeu ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  return (data.text || '').trim();
}

async function resolveEngine() {
  if (resolved !== null) return resolved;

  if (config.voice.sttServerUrl) {
    resolved = { name: 'whisper-server', server: true };
    return resolved;
  }

  if (config.voice.sttCommand) {
    resolved = { name: 'STT_COMMAND', custom: true };
    return resolved;
  }

  for (const candidate of CANDIDATES) {
    const check = await run(candidate.bin, ['--help'], { timeoutMs: 8000 });
    // Muitos CLIs saem com codigo != 0 no --help mas existem; o que importa
    // e nao ter dado ENOENT.
    if (check.code !== -1) {
      // Nem toda build do whisper.cpp aceita prompt inicial, e mandar uma flag
      // que ele nao conhece derruba a transcricao inteira. Pergunta antes.
      const ajuda = `${check.stdout} ${check.stderr}`;
      resolved = { ...candidate, aceitaPrompt: /--prompt\b/.test(ajuda) };
      return resolved;
    }
  }

  resolved = false;
  return resolved;
}

/**
 * O whisper ALUCINA em audio quase mudo.
 *
 * Ele foi treinado em legendas de video, e quando recebe silencio ou barulho
 * sem fala ele devolve o que aquele corpus tem de mais comum: anotacoes entre
 * colchetes, agradecimento de fim de video, credito de legendagem. Nao e erro
 * de configuracao, e como o modelo se comporta — e por isso precisa ser barrado
 * aqui, e nao ajustado la.
 *
 * O caso que motivou isto veio do log de uso: uma musica tocando no comodo
 * virou "[MÚSICA DE FUNDO]", o roteador tratou como pedido e abriu YouTube.
 * Alucinacao virando acao e o pior desfecho possivel — o assistente parece
 * possuido, e nada no log explica por que.
 */
const ARTEFATOS = [
  // Anotacao de nao-fala: colchete ou parentese ocupando a frase inteira.
  /^[\[(][^\])]*[\])][.!?\s]*$/,
  /^[♪♫~\-.\s]*$/,
  // Creditos de legenda que aparecem sozinhos no fim dos videos do corpus.
  /legendas?\s+(pela|por)\s+/i,
  /amara\.?org/i,
  /subtitles?\s+by/i,
  // Fim de video. Como frase INTEIRA — "obrigado" no meio de um pedido e
  // legitimo, e so sozinho que denuncia alucinacao.
  /^(muito\s+)?obrigad[oa]([.!\s]*(por\s+assistir|pessoal|gente))?[.!\s]*$/i,
  /^(tchau|ate\s+a\s+proxima|ate\s+mais)[.!\s]*$/i,
  /^inscreva-?se[^.]*$/i,
  /^(bom\s+dia|boa\s+noite|boa\s+tarde)[.!\s]*$/i,
];

/**
 * Isto e fala de verdade, ou lixo que o whisper inventou?
 *
 * Fica separado do `transcribe` porque a escuta e o comando usam a mesma regra
 * e nenhum dos dois pode agir em cima de alucinacao.
 */
export function ehArtefato(texto) {
  const limpo = String(texto || '').trim();
  if (!limpo) return true;

  // Frase de uma letra ou duas nao e comando; e ruido que virou silaba.
  const semPontuacao = limpo.replace(/[^\p{L}\p{N}]/gu, '');
  if (semPontuacao.length < 3) return true;

  return ARTEFATOS.some((re) => re.test(limpo));
}

/**
 * Transcreve um WAV 16kHz mono. Devolve o texto ou null.
 */
export async function transcribe(wavPath) {
  let engine = await resolveEngine();

  if (engine === false) {
    throw new Error(
      'Nenhum motor de STT encontrado. Instale uma das opcoes:\n' +
        '  whisper.cpp  → https://github.com/ggml-org/whisper.cpp (deixe whisper-cli no PATH)\n' +
        '  Python       → pip install -U openai-whisper\n' +
        'Ou aponte STT_COMMAND no .env pro seu proprio transcritor.'
    );
  }

  if (engine.server) {
    try {
      return (await transcribeViaServer(wavPath)) || null;
    } catch (err) {
      // O servidor e otimizacao, nao requisito. Ele fora do ar nao pode
      // significar assistente surdo se existe um comando local configurado.
      if (!config.voice.sttCommand) throw err;
      console.error(`[stt] servidor fora do ar, usando o comando local: ${err.message}`);
      engine = { name: 'STT_COMMAND', custom: true };
    }
  }

  if (engine.custom) {
    // Substitui {file} depois de quebrar, senao um caminho temporario com
    // espaco (usuario "Ana Paula") viraria dois argumentos.
    const [cmd, ...args] = tokenize(config.voice.sttCommand).map((t) =>
      t.replace('{file}', wavPath)
    );
    const result = await run(cmd, args, { timeoutMs: 120000 });
    if (result.code === -1) {
      throw new Error(
        `Nao consegui rodar o STT_COMMAND: ${cmd}\n${result.stderr || 'executavel nao encontrado'}`
      );
    }
    return result.stdout.trim() || null;
  }

  const args = engine.args(wavPath);
  if (engine.aceitaPrompt) args.push('--prompt', promptDeVocabulario());

  const result = await run(engine.bin, args, { timeoutMs: 120000 });
  if (result.code === -1) throw new Error(`Falha ao rodar ${engine.bin}: ${result.stderr}`);

  const text = engine.parse(result.stdout, wavPath);
  return text || null;
}

export async function sttEngineName() {
  const engine = await resolveEngine();
  return engine === false ? null : engine.name;
}
