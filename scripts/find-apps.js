#!/usr/bin/env node
import pc from 'picocolors';
import { psJson } from '../src/platform/win32.js';
import { config, loadJson, saveJson } from '../src/core/config.js';

/**
 * Descobre o que esta instalado e registra os apelidos em config/apps.json.
 *
 * Existe porque caminho de instalacao no Windows nao e adivinhavel: o Roblox
 * fica numa pasta com o numero da versao dentro, apps da Store nao tem .exe
 * fixo, e cada instalador escolhe entre Program Files, AppData e ProgramData.
 * Chutar caminho gera app que "existe" no registro e nao abre.
 *
 * O Menu Iniciar ja tem essa resposta: todo instalador poe um atalho la, e o
 * atalho sabe o alvo real. Entao a fonte da verdade e ele.
 *
 *   npm run apps:find              lista o que achou, nao grava
 *   npm run apps:find roblox       filtra pelo nome
 *   npm run apps:find -- --salvar  grava os que faltam em config/apps.json
 */

// Atalho de desinstalador ou de documentacao nao e app pra abrir por voz.
const IGNORAR =
  /uninstall|desinstalar|readme|leia-?me|licen[cs]a|license|help|ajuda|manual|documenta|report a bug|website|site oficial/i;

// O resultado sai numa VARIAVEL e a ultima linha e ela sozinha. Um `foreach`
// do PowerShell e comando, nao expressao: canalizar ele direto pro
// ConvertTo-Json e erro de sintaxe, nao de execucao — falha antes de rodar.
const SCRIPT = String.raw`
$sh = New-Object -ComObject WScript.Shell
$pastas = @(
  "$env:APPDATA\Microsoft\Windows\Start Menu\Programs",
  "$env:ProgramData\Microsoft\Windows\Start Menu\Programs"
)
$vistos = @{}
$achados = @(
  foreach ($p in $pastas) {
    if (-not (Test-Path $p)) { continue }
    Get-ChildItem -Path $p -Filter *.lnk -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
      try {
        $alvo = $sh.CreateShortcut($_.FullName).TargetPath
        if ($alvo -and -not $vistos.ContainsKey($_.BaseName)) {
          $vistos[$_.BaseName] = $true
          [PSCustomObject]@{ nome = $_.BaseName; alvo = $alvo }
        }
      } catch {}
    }
  }
)
$achados
`.trim();

function normalizar(nome) {
  return nome
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    // "Discord (2)", "Spotify - Atalho", "OBS Studio (64bit)"
    .replace(/\s*\(.*?\)\s*/g, ' ')
    .replace(/\s*-\s*(atalho|shortcut)$/i, '')
    .trim();
}

async function main() {
  const args = process.argv.slice(2);
  const salvar = args.includes('--salvar');
  const filtro = args.find((a) => !a.startsWith('--'))?.toLowerCase();

  console.log(pc.bold(pc.cyan('\n  Apps instalados — vindos do Menu Iniciar\n')));

  const { ok, data, error } = await psJson(SCRIPT, { timeoutMs: 60000 });
  if (!ok) {
    console.error(pc.red(`  falhou ao ler o Menu Iniciar: ${error}\n`));
    process.exit(1);
  }

  // Um atalho so nao vira array no ConvertTo-Json.
  const achados = (Array.isArray(data) ? data : data ? [data] : [])
    .filter((a) => a.nome && a.alvo && !IGNORAR.test(a.nome))
    .filter((a) => /\.(exe|lnk)$/i.test(a.alvo))
    .map((a) => ({ apelido: normalizar(a.nome), alvo: a.alvo }))
    .filter((a) => a.apelido && (!filtro || a.apelido.includes(filtro)))
    .sort((a, b) => a.apelido.localeCompare(b.apelido));

  if (!achados.length) {
    console.log(pc.yellow(`  Nada encontrado${filtro ? ` para "${filtro}"` : ''}.\n`));
    if (filtro) console.log(pc.dim('  Tente sem filtro pra ver a lista inteira.\n'));
    return;
  }

  const registro = loadJson(config.paths.apps, {});
  const jaTem = new Set(Object.keys(registro).map((k) => k.toLowerCase()));
  const novos = achados.filter((a) => !jaTem.has(a.apelido));

  for (const a of achados) {
    const marca = jaTem.has(a.apelido) ? pc.dim('  ja tem ') : pc.green('  novo   ');
    console.log(`${marca}${a.apelido.padEnd(28)} ${pc.dim(a.alvo)}`);
  }

  console.log();
  if (!novos.length) {
    console.log(pc.dim('  Todos ja estao registrados.\n'));
    return;
  }

  if (!salvar) {
    console.log(`  ${novos.length} app(s) fora do registro.`);
    console.log(pc.cyan(`    npm run apps:find${filtro ? ` ${filtro}` : ''} -- --salvar`));
    console.log(pc.dim('  Depois disso da pra abrir por voz pelo nome que aparece acima.\n'));
    return;
  }

  for (const a of novos) registro[a.apelido] = a.alvo;
  saveJson(config.paths.apps, registro);
  console.log(pc.green(`  Registrei ${novos.length} app(s) em ${config.paths.apps}\n`));
  console.log(pc.dim('  O nome falado nao precisa ser exato: erro de transcricao e'));
  console.log(pc.dim('  resolvido na hora de abrir.\n'));
}

main().catch((err) => {
  console.error(pc.red(`\n  falhou: ${err.message}\n`));
  process.exit(1);
});
