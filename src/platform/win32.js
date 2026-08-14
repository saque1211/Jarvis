import { spawn } from 'node:child_process';
import { config } from '../core/config.js';

/**
 * Camada Windows. Tudo que toca a maquina passa por aqui, entao trocar de SO
 * no futuro e escrever um irmao deste arquivo em vez de cacar spawn() solto.
 */

export const isWindows = process.platform === 'win32';

function assertWindows(what) {
  if (!isWindows) {
    throw new Error(
      `"${what}" so funciona no Windows. Plataforma atual: ${process.platform}. ` +
        'O JARVIS foi configurado pra Windows 11 — rode-o na sua maquina.'
    );
  }
}

/**
 * Executa um processo e devolve stdout/stderr/exitCode sem passar por shell,
 * entao nao existe injecao via argumento.
 */
export function run(command, args = [], options = {}) {
  const timeout = options.timeoutMs ?? config.safety.commandTimeoutMs;
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env || {}) },
      windowsHide: true,
      shell: false,
      // `detached` poe o filho num grupo de processos proprio. Importa pra
      // quem LANCA app: sem isso o app nasce no grupo do JARVIS e pode morrer
      // junto com o PowerShell que o abriu — abre e fecha na hora.
      detached: options.detached === true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeout);

    child.stdout?.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, code: -1, stdout, stderr: err.message, timedOut });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut,
        code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        timedOut,
      });
    });

    if (options.stdin) {
      child.stdin.write(options.stdin);
      child.stdin.end();
    }
  });
}

/**
 * Roda um script PowerShell. Usa -EncodedCommand (UTF-16LE em base64) porque
 * isso elimina de vez o inferno de escapar aspas entre cmd.exe e PowerShell.
 */
export async function ps(script, options = {}) {
  assertWindows('PowerShell');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    options
  );
}

/** Nome provavel do processo a partir do alvo, pra conferir se ele ficou de pe. */
export function nomeDeProcesso(target) {
  const t = String(target).trim();
  // URI de app ("spotify:", "discord:", "steam://open/main")
  const uri = t.match(/^([a-z][a-z0-9+.-]*):/i);
  if (uri && !/^[a-z]:[\\/]/i.test(t)) return uri[1];
  // Caminho ou executavel
  return t.split(/[\\/]/).pop().replace(/\.exe$/i, '');
}

/**
 * Diz se existe processo com esse nome. O Windows nomeia o processo sem o
 * .exe, e nem sempre igual ao atalho — por isso quem chama trata "nao achei"
 * como duvida, nao como falha.
 */
export async function processoVivo(nome) {
  const { ok, stdout } = await ps(
    `@(Get-Process -Name ${psQuote(nome)} -ErrorAction SilentlyContinue).Count`
  );
  return ok && Number(stdout.trim()) > 0;
}

/** Roda PowerShell e faz parse do stdout como JSON. */
/**
 * PowerShell de longa duracao, uma linha de stdout por evento. Diferente do
 * `ps()`, que espera terminar — este fica vivo e vai avisando.
 *
 * Devolve { stop() } e chama onLine a cada linha. Usado pelo gatilho de tecla
 * de atalho, que precisa vigiar o teclado sem bloquear o daemon.
 */
export function psLines(script, onLine) {
  assertWindows('PowerShell');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { windowsHide: true }
  );

  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) onLine(trimmed);
    }
  });

  return {
    stop() {
      try {
        child.kill();
      } catch {
        // Ja morreu, tudo bem.
      }
    },
  };
}

/**
 * Sobe um processo de longa duracao em segundo plano e devolve { stop() }.
 * Diferente do `run()`, que espera terminar.
 */
export function startBackground(command, args = [], options = {}) {
  const child = spawn(command, args, {
    windowsHide: true,
    stdio: 'ignore',
    env: { ...process.env, ...(options.env || {}) },
  });

  child.on('error', () => {
    // Quem chama verifica se o servico respondeu; um erro aqui nao pode
    // derrubar o processo pai.
  });

  return {
    stop() {
      try {
        child.kill();
      } catch {
        // Ja morreu.
      }
    },
  };
}

export async function psJson(script, options = {}) {
  // O trim nao e cosmetico: com quebra de linha no fim, o pipe cai na linha
  // seguinte e o PowerShell recusa com "elemento pipe vazio" — erro que fala
  // do pipe e nao do espaco em branco que o causou.
  const wrapped = `${script.trim()} | ConvertTo-Json -Depth 6 -Compress`;
  const result = await ps(wrapped, options);
  if (!result.ok) return { ok: false, error: result.stderr || `exit ${result.code}`, data: null };
  if (!result.stdout) return { ok: true, data: null };
  try {
    return { ok: true, data: JSON.parse(result.stdout) };
  } catch {
    return { ok: false, error: `Saida nao era JSON: ${result.stdout.slice(0, 200)}`, data: null };
  }
}

/** Escapa uma string pra virar literal PowerShell entre aspas simples. */
export function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Abre um app, arquivo, pasta ou URL usando o handler padrao do Windows. */
export async function startProcess(target, args = [], options = {}) {
  assertWindows('Start-Process');
  const parts = [`Start-Process -FilePath ${psQuote(target)}`];
  if (args.length) {
    parts.push(`-ArgumentList @(${args.map(psQuote).join(',')})`);
  }
  if (options.workingDirectory) {
    parts.push(`-WorkingDirectory ${psQuote(options.workingDirectory)}`);
  }
  if (options.windowStyle) {
    parts.push(`-WindowStyle ${options.windowStyle}`);
  }
  // detached: o app aberto nao pode depender de quem o abriu continuar vivo.
  return ps(parts.join(' '), { detached: true });
}

/**
 * Envia uma tecla virtual do teclado (inclusive as teclas de midia, que o
 * Windows entrega global pro app que estiver tocando som).
 */
export const VK = {
  VOLUME_MUTE: 0xad,
  VOLUME_DOWN: 0xae,
  VOLUME_UP: 0xaf,
  MEDIA_NEXT: 0xb0,
  MEDIA_PREV: 0xb1,
  MEDIA_STOP: 0xb2,
  MEDIA_PLAY_PAUSE: 0xb3,
};

export async function sendVirtualKey(code, repeat = 1) {
  assertWindows('teclas de midia');
  const script = `
Add-Type -Name JKeys -Namespace Jarvis -MemberDefinition @"
[DllImport("user32.dll")]
public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo);
"@
for ($i = 0; $i -lt ${Number(repeat)}; $i++) {
  [Jarvis.JKeys]::keybd_event(${Number(code)}, 0, 0, [System.UIntPtr]::Zero)
  [Jarvis.JKeys]::keybd_event(${Number(code)}, 0, 2, [System.UIntPtr]::Zero)
  Start-Sleep -Milliseconds 40
}
`;
  return ps(script);
}

/** Lista processos por nome (match parcial, sem case). */
export async function listProcesses(filter) {
  const script = filter
    ? `Get-Process | Where-Object { $_.ProcessName -like ${psQuote(`*${filter}*`)} } | Select-Object ProcessName, Id, @{N='MemMB';E={[math]::Round($_.WorkingSet64/1MB,1)}}`
    : `Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 20 ProcessName, Id, @{N='MemMB';E={[math]::Round($_.WorkingSet64/1MB,1)}}`;
  return psJson(script);
}

/** Mata um processo pelo nome. */
export async function killProcess(name) {
  return ps(`Stop-Process -Name ${psQuote(name)} -Force -ErrorAction Stop`);
}

/** Mostra uma notificacao nativa do Windows (toast). */
export async function toast(title, message) {
  assertWindows('notificacoes');
  const script = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$texts = $template.GetElementsByTagName('text')
$texts.Item(0).AppendChild($template.CreateTextNode(${psQuote(title)})) | Out-Null
$texts.Item(1).AppendChild($template.CreateTextNode(${psQuote(message)})) | Out-Null
$toast = [Windows.UI.Notifications.ToastNotification]::new($template)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('JARVIS').Show($toast)
`;
  return ps(script);
}
