import { ps, psJson, run, startProcess, sendVirtualKey, VK } from '../platform/win32.js';

/**
 * Skill: hardware — vitais da maquina, monitores, energia e VR (Quest 3S).
 *
 * GPU depende do nvidia-smi (vem com o driver NVIDIA). Em AMD/Intel o
 * comando falha e a gente reporta isso em vez de fingir que leu.
 */

async function cpuLoad() {
  const { ok, data } = await psJson(
    `Get-CimInstance Win32_Processor | Select-Object Name, LoadPercentage, NumberOfCores, MaxClockSpeed`
  );
  if (!ok || !data) return null;
  return Array.isArray(data) ? data[0] : data;
}

async function memory() {
  const { ok, data } = await psJson(
    `Get-CimInstance Win32_OperatingSystem | Select-Object ` +
      `@{N='TotalGB';E={[math]::Round($_.TotalVisibleMemorySize/1MB,1)}}, ` +
      `@{N='FreeGB';E={[math]::Round($_.FreePhysicalMemory/1MB,1)}}`
  );
  if (!ok || !data) return null;
  return data;
}

async function gpu() {
  const result = await run('nvidia-smi', [
    '--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu',
    '--format=csv,noheader,nounits',
  ]);
  if (!result.ok || !result.stdout) return null;
  const [name, util, memUsed, memTotal, temp] = result.stdout.split(',').map((s) => s.trim());
  return { name, util: Number(util), memUsed: Number(memUsed), memTotal: Number(memTotal), temp: Number(temp) };
}

async function disks() {
  const { ok, data } = await psJson(
    `Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Select-Object DeviceID, ` +
      `@{N='FreeGB';E={[math]::Round($_.FreeSpace/1GB,1)}}, ` +
      `@{N='TotalGB';E={[math]::Round($_.Size/1GB,1)}}`
  );
  if (!ok || !data) return [];
  return Array.isArray(data) ? data : [data];
}

export default {
  name: 'hardware',
  description: 'Monitorar CPU/GPU/RAM/disco, controlar monitores, energia e headset VR.',
  tools: [
    {
      name: 'system_stats',
      description:
        'Le os vitais da maquina: CPU, RAM, GPU, disco e temperatura. ' +
        'Use quando o usuario perguntar como esta a maquina, se esta pesada, quanto sobra de espaco.',
      input_schema: { type: 'object', properties: {} },
      handler: async () => {
        const [cpu, mem, g, dsk] = await Promise.all([cpuLoad(), memory(), gpu(), disks()]);
        const lines = [];

        if (cpu) {
          lines.push(`CPU: ${cpu.Name?.trim()} — ${cpu.LoadPercentage ?? '?'}% de uso, ${cpu.NumberOfCores} nucleos`);
        }
        if (mem) {
          const used = (mem.TotalGB - mem.FreeGB).toFixed(1);
          const pct = Math.round(((mem.TotalGB - mem.FreeGB) / mem.TotalGB) * 100);
          lines.push(`RAM: ${used} de ${mem.TotalGB} GB em uso (${pct}%)`);
        }
        if (g) {
          lines.push(
            `GPU: ${g.name} — ${g.util}% de uso, ${g.memUsed}/${g.memTotal} MB de VRAM, ${g.temp}C`
          );
        } else {
          lines.push('GPU: nvidia-smi indisponivel (GPU nao-NVIDIA ou driver sem o utilitario).');
        }
        for (const d of dsk) {
          lines.push(`Disco ${d.DeviceID} ${d.FreeGB} GB livres de ${d.TotalGB} GB`);
        }
        return lines.join('\n') || 'Nao consegui ler os vitais.';
      },
    },
    {
      name: 'gpu_stats',
      description: 'Le so a GPU, com detalhe: uso, VRAM, temperatura, clock e processos usando a placa.',
      input_schema: { type: 'object', properties: {} },
      handler: async () => {
        const g = await gpu();
        if (!g) return 'nvidia-smi nao respondeu. Sua GPU e NVIDIA e o driver esta instalado?';
        const procs = await run('nvidia-smi', [
          '--query-compute-apps=process_name,used_memory',
          '--format=csv,noheader',
        ]);
        const running = procs.ok && procs.stdout ? `\nProcessos na GPU:\n${procs.stdout}` : '';
        return (
          `${g.name}: ${g.util}% de uso, ${g.memUsed}/${g.memTotal} MB de VRAM, ${g.temp}C${running}`
        );
      },
    },
    {
      name: 'monitor_control',
      description:
        'Liga, desliga ou reconfigura os monitores. "off" apaga as telas (acorda com qualquer tecla). ' +
        'Modos: internal, clone, extend, external.',
      input_schema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['off', 'on', 'internal', 'clone', 'extend', 'external'],
            description: 'O que fazer com os monitores.',
          },
        },
        required: ['action'],
      },
      handler: async ({ action }) => {
        if (action === 'off') {
          const script = `
Add-Type -Name JMon -Namespace Jarvis -MemberDefinition @"
[DllImport("user32.dll")]
public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
"@
# WM_SYSCOMMAND / SC_MONITORPOWER / power off
[Jarvis.JMon]::SendMessage(0xFFFF, 0x0112, [IntPtr]0xF170, [IntPtr]2) | Out-Null
`;
          await ps(script);
          return 'Monitores desligados.';
        }
        if (action === 'on') {
          // Um toque de tecla inofensivo acorda as telas.
          await sendVirtualKey(0x10);
          return 'Monitores acordados.';
        }

        const modes = { internal: '/internal', clone: '/clone', extend: '/extend', external: '/external' };
        const result = await run('DisplaySwitch.exe', [modes[action]]);
        return result.ok ? `Monitores em modo ${action}.` : `Falhou: ${result.stderr}`;
      },
    },
    {
      name: 'power_control',
      description:
        'Bloqueia, suspende, hiberna, reinicia ou desliga a maquina. ' +
        'Reiniciar e desligar sao DESTRUTIVOS — confirme com o usuario antes e passe confirmed=true.',
      input_schema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['lock', 'sleep', 'hibernate', 'restart', 'shutdown'],
          },
          confirmed: { type: 'boolean', description: 'Obrigatorio true pra restart/shutdown.' },
        },
        required: ['action'],
      },
      handler: async ({ action, confirmed }) => {
        if (['restart', 'shutdown'].includes(action) && !confirmed) {
          return `Nao executei "${action}". Confirme com o usuario e chame de novo com confirmed=true.`;
        }
        switch (action) {
          case 'lock':
            await run('rundll32.exe', ['user32.dll,LockWorkStation']);
            return 'Maquina bloqueada.';
          case 'sleep':
            await run('rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0']);
            return 'Suspendendo.';
          case 'hibernate':
            await run('shutdown.exe', ['/h']);
            return 'Hibernando.';
          case 'restart':
            await run('shutdown.exe', ['/r', '/t', '10']);
            return 'Reiniciando em 10 segundos.';
          case 'shutdown':
            await run('shutdown.exe', ['/s', '/t', '10']);
            return 'Desligando em 10 segundos.';
          default:
            return 'Acao desconhecida.';
        }
      },
    },
    {
      name: 'vr_launch',
      description:
        'Inicia a stack de VR pro Quest 3S. "link" abre o app da Meta (Quest Link por cabo/Air Link), ' +
        '"steamvr" abre o SteamVR, "virtual_desktop" abre o streamer do Virtual Desktop.',
      input_schema: {
        type: 'object',
        properties: {
          target: { type: 'string', enum: ['link', 'steamvr', 'virtual_desktop'] },
        },
        required: ['target'],
      },
      handler: async ({ target }) => {
        const targets = {
          link: 'C:\\Program Files\\Oculus\\Support\\oculus-client\\OculusClient.exe',
          steamvr: 'steam://rungameid/250820',
          virtual_desktop: 'steam://rungameid/382110',
        };
        const result = await startProcess(targets[target]);
        if (!result.ok) {
          return `Nao consegui iniciar ${target}. Confira o caminho em config/apps.json. ${result.stderr}`;
        }
        return `Iniciando ${target === 'link' ? 'Quest Link' : target}.`;
      },
    },
    {
      name: 'quest_adb',
      description:
        'Fala com o Quest 3S standalone via ADB (precisa de Modo Desenvolvedor ligado e adb no PATH). ' +
        'Use pra ver bateria, listar dispositivos, instalar APK ou abrir um app no headset.',
      input_schema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['devices', 'battery', 'launch_app', 'install_apk', 'shell'],
          },
          value: {
            type: 'string',
            description: 'Package name pro launch_app, caminho do APK pro install_apk, comando pro shell.',
          },
        },
        required: ['action'],
      },
      handler: async ({ action, value }) => {
        const check = await run('adb', ['devices']);
        if (!check.ok) {
          return 'ADB nao encontrado. Instale as Platform Tools do Android e coloque o adb no PATH.';
        }
        if (!check.stdout.split('\n').slice(1).some((l) => l.trim().endsWith('device'))) {
          return 'Nenhum Quest conectado. Ligue o headset, plugue o cabo e aceite a depuracao USB.';
        }

        switch (action) {
          case 'devices':
            return check.stdout;
          case 'battery': {
            const r = await run('adb', ['shell', 'dumpsys', 'battery']);
            const level = r.stdout.match(/level:\s*(\d+)/)?.[1];
            return level ? `Quest com ${level}% de bateria.` : r.stdout.slice(0, 500);
          }
          case 'launch_app': {
            if (!value) return 'Preciso do package name. Ex: com.oculus.browser';
            const r = await run('adb', ['shell', 'monkey', '-p', value, '-c', 'android.intent.category.LAUNCHER', '1']);
            return r.ok ? `Abri ${value} no Quest.` : `Falhou: ${r.stderr}`;
          }
          case 'install_apk': {
            if (!value) return 'Preciso do caminho do APK.';
            const r = await run('adb', ['install', '-r', value], { timeoutMs: 300000 });
            return r.ok ? `Instalei ${value} no Quest.` : `Falhou: ${r.stderr || r.stdout}`;
          }
          case 'shell': {
            if (!value) return 'Preciso do comando.';
            const r = await run('adb', ['shell', ...value.split(' ')]);
            return r.stdout || r.stderr || '(sem saida)';
          }
          default:
            return 'Acao desconhecida.';
        }
      },
    },
    {
      name: 'battery_status',
      speaks: true,
      description: 'Le a bateria do notebook (se houver) e o estado da energia.',
      input_schema: { type: 'object', properties: {} },
      handler: async () => {
        const { ok, data } = await psJson(
          `Get-CimInstance Win32_Battery | Select-Object EstimatedChargeRemaining, BatteryStatus`
        );
        if (!ok || !data) return 'Sem bateria detectada — provavelmente e um desktop.';
        const b = Array.isArray(data) ? data[0] : data;
        const charging = b.BatteryStatus === 2 ? ' (na tomada)' : '';
        return `Bateria em ${b.EstimatedChargeRemaining}%${charging}.`;
      },
    },
  ],
};
