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
  form.append('file', new Blob([fs.readFileSync(wavPath)]), path.basename(wavPath));
  form.append('response_format', 'json');
  form.append('language', 'pt');
  if (config.voice.sttPrompt) form.append('prompt', config.voice.sttPrompt);

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
      resolved = candidate;
      return resolved;
    }
  }

  resolved = false;
  return resolved;
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

  const result = await run(engine.bin, engine.args(wavPath), { timeoutMs: 120000 });
  if (result.code === -1) throw new Error(`Falha ao rodar ${engine.bin}: ${result.stderr}`);

  const text = engine.parse(result.stdout, wavPath);
  return text || null;
}

export async function sttEngineName() {
  const engine = await resolveEngine();
  return engine === false ? null : engine.name;
}
