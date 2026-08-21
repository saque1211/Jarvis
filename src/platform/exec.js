import { spawn } from 'node:child_process';
import { config } from '../core/config.js';

/**
 * Execucao de processo, sem SO nenhum embutido.
 *
 * Mora fora do win32.js porque o Raspberry precisa da mesma funcao e nao pode
 * importar um arquivo com o nome de outra plataforma. E a regra do projeto —
 * nada de spawn solto numa skill — vale igual nos dois lados.
 */

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
