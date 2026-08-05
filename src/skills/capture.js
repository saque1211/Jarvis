import fs from 'node:fs';
import path from 'node:path';
import { ps, psQuote, run, startProcess } from '../platform/win32.js';
import { config } from '../core/config.js';
import { appendDaily } from '../core/vault.js';

/**
 * Skill: capturar tela.
 *
 * Screenshot e nativo (System.Drawing, sem dependencia externa).
 * Gravacao usa ffmpeg se existir; senao cai no Game Bar do Windows (Win+Alt+R),
 * que ja vem instalado mas so grava a janela em foco.
 */

function captureDir() {
  fs.mkdirSync(config.paths.captures, { recursive: true });
  return config.paths.captures;
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

let recorder = null;

export default {
  name: 'capture',
  description: 'Tirar screenshots, gravar a tela e fazer clips.',
  tools: [
    {
      name: 'screenshot',
      description:
        'Tira um print. mode="full" pega todos os monitores, "primary" so o principal, ' +
        '"window" a janela em foco. O arquivo vai pra pasta de capturas.',
      input_schema: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['full', 'primary', 'window'], description: 'Padrao: primary.' },
          name: { type: 'string', description: 'Nome do arquivo, sem extensao.' },
          open_after: { type: 'boolean', description: 'Abre a imagem depois de salvar.' },
        },
      },
      handler: async ({ mode = 'primary', name, open_after }) => {
        const file = path.join(captureDir(), `${name || `shot-${stamp()}`}.png`);

        const boundsExpr =
          mode === 'full'
            ? `[System.Windows.Forms.SystemInformation]::VirtualScreen`
            : mode === 'window'
              ? `$null` // resolvido abaixo via GetForegroundWindow
              : `[System.Windows.Forms.Screen]::PrimaryScreen.Bounds`;

        const windowBlock =
          mode === 'window'
            ? `
Add-Type -Name JCap -Namespace Jarvis -MemberDefinition @"
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
public struct RECT { public int Left, Top, Right, Bottom; }
"@
$hwnd = [Jarvis.JCap]::GetForegroundWindow()
$rect = New-Object Jarvis.JCap+RECT
[Jarvis.JCap]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
$bounds = New-Object System.Drawing.Rectangle($rect.Left, $rect.Top, ($rect.Right - $rect.Left), ($rect.Bottom - $rect.Top))
`
            : `$bounds = ${boundsExpr}`;

        const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
${windowBlock}
$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$graphics = [System.Drawing.Graphics]::FromImage($bmp)
$graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bmp.Size)
$bmp.Save(${psQuote(file)}, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bmp.Dispose()
Write-Output ${psQuote(file)}
`;
        const result = await ps(script);
        if (!result.ok) return `Falhou ao capturar: ${result.stderr}`;
        if (open_after) await startProcess(file);
        appendDaily('Captura', `Screenshot: ${file}`);
        return `Print salvo em ${file}.`;
      },
    },
    {
      name: 'start_recording',
      description:
        'Comeca a gravar a tela. Usa ffmpeg quando disponivel (melhor qualidade e controle). ' +
        'Chame stop_recording pra encerrar.',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Nome do arquivo, sem extensao.' },
          fps: { type: 'number', description: 'Quadros por segundo. Padrao 30.' },
          with_audio: { type: 'boolean', description: 'Grava tambem o audio do sistema.' },
        },
      },
      handler: async ({ name, fps = 30, with_audio }) => {
        if (recorder) return 'Ja tem uma gravacao rolando. Pare a atual antes de comecar outra.';

        const ffmpegCheck = await run('ffmpeg', ['-version'], { timeoutMs: 5000 });
        const file = path.join(captureDir(), `${name || `rec-${stamp()}`}.mp4`);

        if (!ffmpegCheck.ok) {
          // Game Bar: Win+Alt+R. Nao da pra controlar o arquivo, mas funciona sem instalar nada.
          await ps(`(New-Object -ComObject WScript.Shell).SendKeys('^%r')`);
          return (
            'ffmpeg nao encontrado — disparei o Game Bar (Win+Alt+R). ' +
            'O video vai pra pasta Videos/Capturas. Instale o ffmpeg pra eu controlar a gravacao direito.'
          );
        }

        const args = [
          '-y',
          '-f', 'gdigrab',
          '-framerate', String(fps),
          '-i', 'desktop',
        ];
        if (with_audio) {
          args.push('-f', 'dshow', '-i', 'audio=virtual-audio-capturer');
        }
        args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', file);

        const { spawn } = await import('node:child_process');
        recorder = { proc: spawn('ffmpeg', args, { windowsHide: true }), file, startedAt: Date.now() };
        recorder.proc.on('error', () => {
          recorder = null;
        });
        return `Gravando em ${file}. Fale "para de gravar" quando terminar.`;
      },
    },
    {
      name: 'stop_recording',
      description: 'Encerra a gravacao de tela em andamento e salva o arquivo.',
      input_schema: { type: 'object', properties: {} },
      handler: async () => {
        if (!recorder) {
          await ps(`(New-Object -ComObject WScript.Shell).SendKeys('^%r')`);
          return 'Nao havia gravacao minha ativa — mandei o atalho do Game Bar por via das duvidas.';
        }
        // 'q' no stdin faz o ffmpeg finalizar o container direito (kill corrompe o mp4).
        recorder.proc.stdin.write('q');
        const { file, startedAt } = recorder;
        const seconds = Math.round((Date.now() - startedAt) / 1000);
        recorder = null;
        await new Promise((r) => setTimeout(r, 1200));
        appendDaily('Captura', `Gravacao (${seconds}s): ${file}`);
        return `Parei de gravar. ${seconds} segundos salvos em ${file}.`;
      },
    },
    {
      name: 'list_captures',
      description: 'Lista os prints e gravacoes mais recentes.',
      input_schema: {
        type: 'object',
        properties: { limit: { type: 'number', description: 'Quantos itens. Padrao 10.' } },
      },
      handler: async ({ limit = 10 }) => {
        const dir = captureDir();
        const files = fs
          .readdirSync(dir)
          .map((f) => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
          .sort((a, b) => b.mtime - a.mtime)
          .slice(0, limit);
        if (!files.length) return 'Nenhuma captura ainda.';
        return `${dir}\n${files.map((f) => f.name).join('\n')}`;
      },
    },
  ],
};
