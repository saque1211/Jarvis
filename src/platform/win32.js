import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { run } from './exec.js';

// Reexportado: dezenas de skills fazem `import { run } from '../platform/win32.js'`
// e nao ha ganho nenhum em mexer em todas elas pra mover uma funcao.
export { run };

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

/**
 * Espera o processo APARECER, em vez de olhar uma vez e desistir.
 *
 * Uma espera fixa erra dos dois lados: 2,5s e pouco pro Chrome subindo frio
 * (disco girando, perfil grande, extensao carregando) e e muito pro Bloco de
 * Notas, que abre em 300ms e mesmo assim fazia o assistente ficar mudo o tempo
 * todo antes de responder.
 *
 * Perguntando de meio em meio segundo, o caso comum fica RAPIDO e o caso lento
 * fica CERTO — e cada pergunta custa um PowerShell, entao o teto existe.
 */
export async function esperarProcesso(nome, tetoMs = 8000) {
  const passo = 500;
  const limite = Date.now() + tetoMs;
  let tentativas = 0;

  while (Date.now() < limite) {
    tentativas++;
    if (await processoVivo(nome)) return { vivo: true, esperouMs: tentativas * passo };
    await new Promise((r) => setTimeout(r, passo));
  }
  return { vivo: false, esperouMs: tetoMs };
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

/* ============================================================================
 * CENTRAL DE CONTROLE — rede, brilho, volume, reiniciar.
 *
 * Espelha o que o linux.js faz no Raspberry. O HUD chama sempre pelo
 * platform/index.js e nunca sabe em qual dos dois esta rodando.
 * ==========================================================================*/

/**
 * Quebra a saida do `netsh wlan show networks`.
 *
 * O netsh traduz quase tudo — "Autenticacao", "Sinal" — mas NAO traduz a
 * palavra SSID nem o simbolo `%`. A leitura se apoia so nesses dois, senao o
 * Windows em portugues devolveria lista vazia e ninguem entenderia por que.
 */
export function lerRedesDoNetsh(saida) {
  const redes = [];
  let atual = null;

  for (const linha of String(saida).split('\n')) {
    const inicio = /^\s*SSID\s+\d+\s*:\s*(.*)$/.exec(linha);
    if (inicio) {
      if (atual?.nome) redes.push(atual);
      atual = { nome: inicio[1].trim(), sinal: 0, protegida: false, conectada: false };
      continue;
    }
    if (!atual) continue;

    const sinal = /:\s*(\d{1,3})\s*%/.exec(linha);
    if (sinal) atual.sinal = Math.max(atual.sinal, Number(sinal[1]));
    if (/WPA|WEP/i.test(linha)) atual.protegida = true;
  }
  if (atual?.nome) redes.push(atual);

  return redes.sort((a, b) => b.sinal - a.sinal);
}

/**
 * Tira acento pra comparar.
 *
 * O netsh responde no idioma do Windows: "O Servico de Configuracao Automatica
 * sem Fio (wlansvc) nao esta em execucao." vem com cedilha e til de verdade.
 * Procurar "Servico" sem cedilha nunca casa — foi assim que essa mensagem
 * chegou crua na tela em vez de virar uma explicacao util.
 */
function semAcento(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/** O erro do netsh quer dizer "esta maquina nao faz Wi-Fi"? */
export function wlanIndisponivel(saida) {
  const s = semAcento(saida);
  return (
    // wlansvc parado — o nome do servico nao e traduzido em lugar nenhum.
    s.includes('wlansvc') ||
    s.includes('nao esta em execucao') ||
    s.includes('is not running') ||
    // Desktop com cabo: existe o servico, nao existe a placa.
    s.includes('nenhuma interface') ||
    s.includes('no wireless interface') ||
    s.includes('there is no wireless interface')
  );
}

/**
 * Tem radio Wi-Fi utilizavel nesta maquina?
 *
 * Consulta barata (uma linha de netsh, sem varrer o ar) porque roda no boot do
 * HUD so pra decidir se o controle de Wi-Fi deve existir na tela. Desktop
 * ligado no cabo responde "nao" e a linha some — melhor que um controle que
 * abre uma lista vazia toda vez.
 */
export async function wifiDisponivel() {
  if (!isWindows) return false;
  const r = await run('netsh', ['wlan', 'show', 'interfaces'], { timeoutMs: 10000 });
  if (!r.ok) return false;
  return !wlanIndisponivel(`${r.stdout}${r.stderr}`);
}

export async function listarRedes() {
  assertWindows('listar redes');
  const r = await run('netsh', ['wlan', 'show', 'networks', 'mode=bssid'], { timeoutMs: 20000 });
  if (!r.ok) {
    const saida = `${r.stdout}${r.stderr}`;
    if (wlanIndisponivel(saida)) {
      throw new Error(
        'Este computador nao tem Wi-Fi ligado. Se ele usa cabo, e normal e nao ha o que fazer. ' +
          'Se tem Wi-Fi, ligue o servico: abra services.msc como administrador, ache ' +
          '"Configuracao Automatica de Rede Sem Fio" (WLAN AutoConfig) e ponha em Automatico.'
      );
    }
    throw new Error(`netsh falhou: ${(r.stderr || r.stdout || '').slice(0, 200)}`);
  }

  const redes = lerRedesDoNetsh(r.stdout);
  const atual = await redeAtual();
  for (const rede of redes) rede.conectada = rede.nome === atual;
  return redes.sort((a, b) => (a.conectada === b.conectada ? b.sinal - a.sinal : a.conectada ? -1 : 1));
}

export async function redeAtual() {
  const r = await run('netsh', ['wlan', 'show', 'interfaces'], { timeoutMs: 10000 });
  if (!r.ok) return null;
  // Mesma pegadinha do idioma: procura a linha de SSID que nao seja a de BSSID.
  for (const linha of r.stdout.split('\n')) {
    const m = /^\s*SSID\s*:\s*(.+)$/.exec(linha);
    if (m) return m[1].trim();
  }
  return null;
}

/** SSID em hex, como o perfil XML do Windows exige junto do nome legivel. */
function ssidHex(ssid) {
  return Buffer.from(ssid, 'utf8').toString('hex').toUpperCase();
}

function escaparXml(texto) {
  return String(texto)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Conecta a uma rede nova.
 *
 * No Windows nao existe "conectar com esta senha" em uma linha: o `netsh wlan
 * connect` so aceita um perfil que ja exista. Pra rede nunca vista, o caminho e
 * escrever o perfil XML, importar e so entao conectar.
 */
export async function conectarRede(ssid, senha) {
  assertWindows('conectar a rede');
  if (!ssid) throw new Error('Sem SSID.');

  if (senha) {
    const xml = `<?xml version="1.0"?>
<WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1">
  <name>${escaparXml(ssid)}</name>
  <SSIDConfig><SSID>
    <hex>${ssidHex(ssid)}</hex>
    <name>${escaparXml(ssid)}</name>
  </SSID></SSIDConfig>
  <connectionType>ESS</connectionType>
  <connectionMode>auto</connectionMode>
  <MSM><security>
    <authEncryption>
      <authentication>WPA2PSK</authentication>
      <encryption>AES</encryption>
      <useOneX>false</useOneX>
    </authEncryption>
    <sharedKey>
      <keyType>passPhrase</keyType>
      <protected>false</protected>
      <keyMaterial>${escaparXml(senha)}</keyMaterial>
    </sharedKey>
  </security></MSM>
</WLANProfile>`;

    const arquivo = path.join(os.tmpdir(), `vexis-wifi-${Date.now()}.xml`);
    fs.writeFileSync(arquivo, xml, 'utf8');
    try {
      const add = await run('netsh', ['wlan', 'add', 'profile', `filename=${arquivo}`, 'user=all'], {
        timeoutMs: 15000,
      });
      if (!add.ok) return { ok: false, erro: (add.stderr || add.stdout || '').slice(0, 200) };
    } finally {
      // A senha esta em texto puro dentro dele. Sai do disco na mesma hora.
      try {
        fs.rmSync(arquivo, { force: true });
      } catch {
        /* ignora */
      }
    }
  }

  const conn = await run('netsh', ['wlan', 'connect', `name=${ssid}`], { timeoutMs: 30000 });
  if (!conn.ok) return { ok: false, erro: (conn.stderr || conn.stdout || 'netsh recusou').slice(0, 200) };

  // O netsh volta "solicitacao concluida" antes de a rede subir. Confirma.
  await new Promise((r) => setTimeout(r, 3000));
  const agora = await redeAtual();
  if (agora === ssid) return { ok: true, rede: ssid };
  return { ok: false, erro: 'A conexao foi pedida mas nao completou — senha errada, provavelmente.' };
}

/**
 * Brilho pela WMI. So existe em painel integrado (notebook, tudo-em-um). Em
 * monitor de mesa a WMI simplesmente nao expoe a classe, e reportar
 * indisponivel e melhor que devolver um numero inventado — mesma regra da GPU.
 */
export async function lerBrilho() {
  if (!isWindows) return null;
  const r = await psJson(
    'Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness -ErrorAction Stop | ' +
      'Select-Object -First 1 -Property CurrentBrightness'
  );
  const n = r?.CurrentBrightness;
  return typeof n === 'number' ? n : null;
}

export async function definirBrilho(percentual) {
  assertWindows('mudar o brilho');
  const alvo = Math.max(0, Math.min(100, Math.round(Number(percentual))));
  const r = await ps(
    'Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods -ErrorAction Stop | ' +
      `Invoke-CimMethod -MethodName WmiSetBrightness -Arguments @{ Brightness = ${alvo}; Timeout = 1 }`
  );
  if (r.ok) return { ok: true, nivel: alvo, via: 'wmi' };
  throw new Error(
    'Este Windows nao expoe controle de brilho: a WMI so alcanca painel integrado. ' +
      'Em monitor de mesa, o brilho fica nos botoes do proprio monitor.'
  );
}

/**
 * Volume.
 *
 * LIMITE CONHECIDO, de proposito: o Windows nao tem comando pra ler nem
 * escrever o volume mestre. O caminho real seria P/Invoke na IAudioEndpointVolume
 * via Add-Type — codigo COM com ordem de vtable que, se eu errar em uma linha,
 * chama o metodo errado em vez de falhar. Nao da pra testar isso daqui, entao
 * fica com as teclas de midia: elas mexem de 2 em 2 e sao as mesmas que o
 * teclado usa. O nivel exibido e o que o usuario escolheu, guardado nas
 * preferencias — nao uma leitura do sistema.
 */
export async function lerVolume() {
  return null;
}

export async function definirVolume(percentual, atual = null) {
  assertWindows('mudar o volume');
  const alvo = Math.max(0, Math.min(100, Math.round(Number(percentual))));
  const partida = atual === null ? 50 : Math.max(0, Math.min(100, Math.round(atual)));

  const passos = Math.round(Math.abs(alvo - partida) / 2);
  if (passos > 0) {
    await sendVirtualKey(alvo > partida ? VK.VOLUME_UP : VK.VOLUME_DOWN, Math.min(passos, 50));
  }
  return { ok: true, nivel: alvo, via: 'teclas de midia', exato: false };
}

export async function reiniciarDispositivo() {
  assertWindows('reiniciar');
  const r = await run('shutdown', ['/r', '/t', '0']);
  if (r.ok) return { ok: true };
  throw new Error(`Nao consegui reiniciar: ${r.stderr || r.stdout}`);
}
