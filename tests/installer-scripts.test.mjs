import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const installDir = path.join(root, 'local-runner', 'install');
const scripts = ['install.ps1', 'uninstall.ps1', 'repair.ps1', 'doctor.ps1'];

function readScript(name) {
  return fs.readFileSync(path.join(installDir, name), 'utf8');
}

/** Extracts the param(...) block of a PowerShell script (from `param(` to the closing `)` on its own line). */
function extractParamBlock(source) {
  const match = /param\(([\s\S]*?)\r?\n\)/.exec(source);
  return match ? match[1] : null;
}

test('installer scripts never resolve paths inside parameter defaults (Windows PowerShell 5.1 compatibility)', () => {
  // Regression guard for issue #3: `$PSScriptRoot` is EMPTY while parameter
  // default values are evaluated under Windows PowerShell 5.1 (powershell.exe),
  // so `param([string]$RunnerHome = (Split-Path -Parent $PSScriptRoot))` crashed
  // with "Split-Path: Cannot bind argument to parameter 'Path' because it is an
  // empty string" before the script body ever ran. The docs instruct users to
  // run these scripts via powershell.exe, so param blocks must stay pure.
  for (const name of scripts) {
    const source = readScript(name);
    const paramBlock = extractParamBlock(source);
    assert.ok(paramBlock !== null, `${name} must declare a param() block`);
    assert.equal(paramBlock.includes('$PSScriptRoot'), false, `${name}: $PSScriptRoot must never appear inside param() — it is empty during default-value evaluation on Windows PowerShell 5.1`);
    assert.equal(paramBlock.includes('Split-Path'), false, `${name}: no path resolution inside param()`);
    assert.equal(paramBlock.includes('$MyInvocation'), false, `${name}: no invocation-based resolution inside param()`);
  }
});

test('installer scripts resolve -RunnerHome in the body with an explicit guard and fallbacks', () => {
  for (const name of scripts) {
    const source = readScript(name);
    assert.match(source, /\[string\]\$RunnerHome\s*=\s*''/, `${name}: RunnerHome default must be an empty string (resolved in the body)`);
    assert.match(source, /IsNullOrWhiteSpace\(\$RunnerHome\)/, `${name}: must guard an unset -RunnerHome with [string]::IsNullOrWhiteSpace in the body`);
    assert.match(source, /if \(\$PSScriptRoot\)/, `${name}: must prefer $PSScriptRoot in the body and fall back when it is unexpectedly empty`);
    assert.match(source, /\$MyInvocation\.MyCommand\.Path/, `${name}: must fall back to $MyInvocation.MyCommand.Path when $PSScriptRoot is empty`);
  }
});

test('installer scripts avoid PowerShell 7-only operators (documented entry point is powershell.exe 5.1)', () => {
  for (const name of scripts) {
    const source = readScript(name);
    assert.equal(/\?\?|\?\./.test(source), false, `${name}: must not use PowerShell 7-only syntax (??, ??=, ?.) — users run it with powershell.exe (5.1)`);
  }
});

test('installer package still contains the host manifest template and launcher template', () => {
  assert.ok(fs.existsSync(path.join(installDir, 'x-pilot-runner.cmd.template')), 'x-pilot-runner.cmd.template must exist');
  assert.ok(fs.existsSync(path.join(installDir, 'com.so7ob.x_pilot_runner.template.json')), 'com.so7ob.x_pilot_runner.template.json must exist');
});

test('runner home resolution keeps -RunnerHome explicit usage unchanged', () => {
  // The documented `-RunnerHome <path>` escape hatch must keep working: the
  // scripts only fill the default, they never override an explicit value.
  for (const name of scripts) {
    const source = readScript(name);
    const guard = /if \(\[string\]::IsNullOrWhiteSpace\(\$RunnerHome\)\)[\s\S]*?\$RunnerHome\s*=\s*Split-Path/.exec(source);
    assert.ok(guard !== null, `${name}: RunnerHome must be assigned only when the parameter is empty/whitespace`);
    assert.equal(source.includes("$RunnerHome = (Split-Path"), false, `${name}: the old broken param-default pattern must not return`);
  }
});

test('install.ps1 writes the host manifest BOM-free (Chrome rejects BOM manifests)', () => {
  // Regression guard for issue #6: `Set-Content -Encoding UTF8` on Windows
  // PowerShell 5.1 ALWAYS prepends a UTF-8 BOM (EF BB BF), and Chrome reads the
  // native messaging host manifest with a strict JSON reader that rejects a
  // leading BOM - every connectNative then failed with "Error when
  // communicating with the native messaging host." The manifest must be
  // written through .NET with an explicitly BOM-less encoder, and no script
  // may ever use `-Encoding UTF8` for any file Chrome reads.
  const source = readScript('install.ps1');
  assert.doesNotMatch(source, /Set-Content[^\r\n]*\$manifestPath/i, 'install.ps1: the host manifest must never be written with Set-Content - Windows PowerShell 5.1 `-Encoding UTF8` prepends a UTF-8 BOM, which Chrome rejects (issue #6)');
  assert.doesNotMatch(source, /Out-File[^\r\n]*\$manifestPath/i, 'install.ps1: the host manifest must never be written with Out-File (UTF-16/BOM risk)');
  assert.match(source, /New-Object System\.Text\.UTF8Encoding\(\$false\)/, 'install.ps1: the manifest must be written with an explicitly BOM-less UTF8Encoding');
  assert.match(source, /\[System\.IO\.File\]::WriteAllText\(\$manifestPath,\s*\$manifestJson,\s*\$utf8NoBom\)/, 'install.ps1: the manifest write must go through [System.IO.File]::WriteAllText with the BOM-less encoder');
});

test('install.ps1 self-verifies the manifest bytes it wrote (BOM + JSON round-trip + fields)', () => {
  // A broken registration must fail LOUDLY at install time, never silently at
  // Test Connection time: byte-level BOM rejection, JSON re-parse, and every
  // field Chrome needs (name/type/path/allowed_origins + launcher existence).
  const source = readScript('install.ps1');
  assert.match(source, /ReadAllBytes\(\$manifestPath\)/, 'install.ps1: must read the manifest bytes back for a BOM check');
  assert.match(source, /0xEF[\s\S]{0,120}0xBB[\s\S]{0,120}0xBF/, 'install.ps1: must detect the EF BB BF byte sequence and fail');
  assert.match(source, /ConvertFrom-Json/, 'install.ps1: must round-trip the manifest JSON');
  assert.match(source, /allowed_origins[\s\S]{0,80}-notcontains/, 'install.ps1: must verify allowed_origins contains the extension origin');
  assert.match(source, /Test-Path \$roundTrip\.path/, 'install.ps1: must verify the launcher path written into the manifest exists');
});

test('install.ps1 registers the HKCU default value through the .NET Registry API and reads it back', () => {
  // `Set-ItemProperty -Name '(Default)'` behavior is edition-ambiguous; the
  // .NET Registry API with an explicit empty-string value name is the only
  // unambiguous way to set a key default value, and the read-back proves
  // Chrome will resolve exactly the manifest we wrote.
  const source = readScript('install.ps1');
  assert.match(source, /\[Microsoft\.Win32\.Registry\]::CurrentUser\.CreateSubKey\(\$registrySubKey\)/, 'install.ps1: must create/open the key via [Microsoft.Win32.Registry]::CurrentUser');
  assert.match(source, /SetValue\('',\s*\$manifestPath,\s*\[Microsoft\.Win32\.RegistryValueKind\]::String\)/, 'install.ps1: must set the default value via SetValue with an empty value name');
  assert.match(source, /OpenSubKey\(\$registrySubKey\)\)\.GetValue\(''\)/, 'install.ps1: must read the default value back and compare it');
  assert.doesNotMatch(source, /Set-ItemProperty[\s\S]{0,60}'\(Default\)'/, 'install.ps1: must not rely on the ambiguous Set-ItemProperty (Default) pattern');
});

test('launcher template captures host stderr for diagnostics but never redirects stdout', () => {
  // stdout is the Native Messaging protocol channel: any stdout redirect in
  // the launcher corrupts the framing. stderr must be captured to a log file
  // so bootstrap crashes (e.g. "Cannot find module") stay diagnosable, but the
  // redirect must be skipped when the log dir cannot be created.
  const template = fs.readFileSync(path.join(installDir, 'x-pilot-runner.cmd.template'), 'utf8');
  assert.match(template, /set "HOST_LOG_DIR=%LOCALAPPDATA%\\X-Pilot\\Runner\\logs"/, 'template: must define HOST_LOG_DIR under %LOCALAPPDATA%');
  assert.match(template, /if not exist "%HOST_LOG_DIR%" mkdir "%HOST_LOG_DIR%" >nul 2>&1/, 'template: must create the log dir without polluting stdout');
  assert.match(template, /2>"%HOST_LOG_DIR%\\host-stderr\.log"/, 'template: the host launch must capture stderr to host-stderr.log');
  assert.doesNotMatch(template, /1>/, 'template: stdout must NEVER be redirected (protocol channel)');
  assert.ok(Buffer.from(template, 'utf8').every((b) => b <= 0x7f), 'template: must stay pure ASCII (cmd parses the file in the ANSI codepage)');
});

test('doctor.ps1 exists, is ASCII-only, and runs a live framed PING over the real launch chain', () => {
  // The diagnostic tool must verify exactly what Chrome launches: registry +
  // manifest bytes (BOM detection) + a real framed PING, both directly with
  // node and through the rendered .cmd, without opening Chrome.
  const source = readScript('doctor.ps1');
  assert.match(source, /x-pilot-doctor-host-test\.js/, 'doctor.ps1: must write the embedded live-test script');
  assert.match(source, /'PING'/, 'doctor.ps1: the live test must send a PING request');
  assert.match(source, /frameRequest/, 'doctor.ps1: the live test must speak the framed native messaging protocol');
  assert.match(source, /0xEF[\s\S]{0,120}0xBB[\s\S]{0,120}0xBF/, 'doctor.ps1: must detect a BOM in the registered manifest (issue #6)');
  assert.match(source, /\[Microsoft\.Win32\.Registry\]::CurrentUser\.OpenSubKey\(\$registrySubKey\)/, 'doctor.ps1: must read the actual HKCU registration');
  assert.match(source, /Get-Content -Path \$target -Tail/, 'doctor.ps1: must tail the runner logs');
  assert.match(source, /host-stderr\.log/, 'doctor.ps1: must surface host-stderr.log');
  assert.ok(Buffer.from(source, 'utf8').every((b) => b <= 0x7f), 'doctor.ps1: must stay pure ASCII (Windows PowerShell 5.1 reads BOM-less files as ANSI)');
});

test('all installer scripts stay pure ASCII (PS 5.1 reads BOM-less scripts as ANSI)', () => {
  // Non-ASCII bytes (em-dashes, curly quotes, Arabic) in a BOM-less .ps1 are
  // decoded as mojibake by the ANSI codepage on Windows PowerShell 5.1.
  for (const name of scripts) {
    const bytes = fs.readFileSync(path.join(installDir, name));
    assert.ok(bytes.every((b) => b <= 0x7f), `${name}: must stay pure ASCII`);
  }
});
