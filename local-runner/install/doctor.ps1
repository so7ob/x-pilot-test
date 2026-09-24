<#
.SYNOPSIS
  Diagnoses the X-Pilot Local Runner native messaging installation end to end.

.DESCRIPTION
  Verifies every link Chrome needs before a connectNative can succeed:
    1. Node.js >= 20 on PATH.
    2. Runner package health (package.json, dist/index.js, node_modules, launcher).
    3. The HKCU registry key and its default value (what Chrome actually reads).
    4. The host manifest bytes: UTF-8 BOM detection (issue #6), JSON validity,
       required fields, allowed_origins, launcher existence, and whether the
       registered launcher is the compiled .exe (direct launch, issue #9) or
       the legacy .cmd (cmd.exe pipe redirection chain).
    5. A LIVE framed PING against the real launch chain, three times: directly
       with node dist\index.js, through the rendered x-pilot-runner.cmd, and
       through x-pilot-runner.exe with Chrome-style arguments (caller origin
       + --parent-window) - the direct-launch path. stdout is only read as
       protocol frames.
    6. Tails of runner.log and host-stderr.log (the runner log now records
       the caller origin per session, so Chrome launches are identifiable).
  Prints [PASS]/[FAIL]/[WARN] lines. Exit code 0 only when no check failed.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\doctor.ps1
  powershell -ExecutionPolicy Bypass -File .\doctor.ps1 -RunnerHome "D:\path\to\local-runner"
#>

[CmdletBinding()]
param(
  [string]$RunnerHome = ''
)

$ErrorActionPreference = 'Stop'

# Resolve -RunnerHome inside the script body: $PSScriptRoot is EMPTY while
# parameter default values are evaluated under Windows PowerShell 5.1 (it is
# only populated in the body), so it must never appear in a param() default.
if ([string]::IsNullOrWhiteSpace($RunnerHome)) {
  $scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
  $RunnerHome = Split-Path -Parent $scriptDir
}

$hostName = 'com.so7ob.x_pilot_runner'
$manifestsDir = Join-Path $env:LOCALAPPDATA 'X-Pilot\NativeMessagingHosts'
$manifestPath = Join-Path $manifestsDir "$hostName.json"
$registrySubKey = "Software\Google\Chrome\NativeMessagingHosts\$hostName"
$dataDir = Join-Path $env:LOCALAPPDATA 'X-Pilot\Runner'
$script:failures = 0

function Write-Step($message) { Write-Host "[X-Pilot Doctor] $message" -ForegroundColor Cyan }
function Write-Pass($message) { Write-Host "  [PASS] $message" -ForegroundColor Green }
function Write-FailCheck($message) { Write-Host "  [FAIL] $message" -ForegroundColor Red; $script:failures += 1 }
function Write-WarnCheck($message) { Write-Host "  [WARN] $message" -ForegroundColor Yellow }

$runnerHome = [System.IO.Path]::GetFullPath($RunnerHome)
Write-Step "Runner home: $runnerHome"

# ---------------------------------------------------------------- 1/6 Node.js
Write-Step '1/6 Node.js runtime'
$nodeReady = $false
try { $nodeVersion = (node --version) } catch { $nodeVersion = $null }
if (-not $nodeVersion) {
  Write-FailCheck 'Node.js was not found on PATH. Install Node.js LTS 20+ from https://nodejs.org and re-run.'
} else {
  $nodeMajor = 0
  if ($nodeVersion -match '^v(\d+)') { $nodeMajor = [int]$Matches[1] }
  if ($nodeMajor -lt 20) {
    Write-FailCheck "Node.js >= 20 is required (found $nodeVersion)."
  } else {
    Write-Pass "Node.js $nodeVersion."
    $nodeReady = $true
  }
}

# ------------------------------------------------------------ 2/6 Runner files
Write-Step '2/6 Runner package files'
$distEntry = Join-Path $runnerHome 'dist\index.js'
$launcherPath = Join-Path $runnerHome 'x-pilot-runner.cmd'
$packageJson = Join-Path $runnerHome 'package.json'
$nodeModules = Join-Path $runnerHome 'node_modules'
foreach ($pair in @(@('package.json', $packageJson), @('dist\index.js (built host)', $distEntry), @('node_modules (dependencies)', $nodeModules), @('x-pilot-runner.cmd (rendered launcher)', $launcherPath))) {
  $label = $pair[0]; $target = $pair[1]
  if (Test-Path $target) { Write-Pass "$label present." }
  else { Write-FailCheck "$label MISSING at '$target'. Run install.ps1 (or repair.ps1)." }
}
$launcherExePath = Join-Path $runnerHome 'x-pilot-runner.exe'
if (Test-Path $launcherExePath) { Write-Pass 'x-pilot-runner.exe present (Chrome direct-launch path available).' }
else { Write-WarnCheck 'x-pilot-runner.exe is missing: install fell back to the legacy .cmd launcher. Re-run install.ps1 (v1.5.3+) so Chrome can use the direct-launch path with inherited pipe handles.' }

# ------------------------------------------------------------- 3/6 Registry
Write-Step '3/6 Chrome native messaging registration (HKCU, what Chrome reads)'
$registryKeyHandle = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($registrySubKey)
if ($null -eq $registryKeyHandle) {
  Write-FailCheck "Registry key is missing: HKCU\$registrySubKey. Run install.ps1 with your extension id."
} else {
  $registered = $registryKeyHandle.GetValue('')
  $registryKeyHandle.Close()
  if ([string]::IsNullOrWhiteSpace($registered)) {
    Write-FailCheck 'Registry default value is empty (the key exists but Chrome cannot resolve the manifest). Re-run install.ps1.'
  } elseif (-not (Test-Path $registered)) {
    Write-FailCheck "Registry points to a manifest that does not exist: $registered"
    $manifestPath = $registered
  } else {
    Write-Pass "Registry default value -> $registered"
    # Inspect exactly the file Chrome resolves, not merely the default location.
    if ($registered -ne $manifestPath) { Write-WarnCheck "Registered manifest ($registered) differs from the default location ($manifestPath). The REGISTERED one is inspected below." }
    $manifestPath = $registered
  }
}

# ------------------------------------------------------------- 4/6 Manifest
Write-Step '4/6 Host manifest file (BOM check is the v1.5.1 bug, issue #6)'
$doctorExtId = $null
if (-not (Test-Path $manifestPath)) {
  Write-FailCheck "Manifest not found: $manifestPath"
} else {
  $rawBytes = [System.IO.File]::ReadAllBytes($manifestPath)
  if ($rawBytes.Length -ge 3 -and $rawBytes[0] -eq 0xEF -and $rawBytes[1] -eq 0xBB -and $rawBytes[2] -eq 0xBF) {
    Write-FailCheck "Manifest starts with a UTF-8 BOM (EF BB BF). Chrome cannot parse it - THIS is the v1.5.0/v1.5.1 bug (issue #6). You can fix it in place WITHOUT reinstalling; run this, then fully restart Chrome:"
    Write-Host ('    [IO.File]::WriteAllText(''' + $manifestPath + ''', [IO.File]::ReadAllText(''' + $manifestPath + '''), (New-Object Text.UTF8Encoding($false)))') -ForegroundColor Yellow
  } else {
    Write-Pass 'Manifest is UTF-8 without a BOM.'
  }
  try {
    $manifest = ([System.IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json)
  } catch {
    $manifest = $null
    Write-FailCheck "Manifest is not valid JSON: $($_.Exception.Message)"
  }
  if ($manifest) {
    if ($manifest.name -ne $hostName) { Write-FailCheck "Manifest name is '$($manifest.name)' (expected '$hostName')." } else { Write-Pass "Manifest name: $($manifest.name)" }
    if ($manifest.type -ne 'stdio') { Write-FailCheck "Manifest type is '$($manifest.type)' (expected 'stdio')." } else { Write-Pass 'Manifest type: stdio.' }
    if ($manifest.path) {
      if (Test-Path $manifest.path) { Write-Pass "Manifest path -> $($manifest.path)" }
      else { Write-FailCheck "Manifest path points to a missing launcher: $($manifest.path). Run repair.ps1." }
      if ($manifest.path -like '*.cmd' -or $manifest.path -like '*.bat') {
        Write-WarnCheck "Registered launcher is a batch file ($($manifest.path)): Chrome must launch it through the fragile cmd.exe pipe redirection chain (issue #9). Re-run install.ps1 (v1.5.3+) to register the compiled x-pilot-runner.exe."
      } elseif ($manifest.path -like '*.exe') {
        Write-Pass 'Registered launcher is an .exe: Chrome uses the direct-launch path (issue #9 fix).'
      }
    } else {
      Write-FailCheck 'Manifest has no path field.'
    }
    if ($manifest.allowed_origins) {
      $firstOrigin = @($manifest.allowed_origins)[0]
      if ($firstOrigin -match '^chrome-extension://([a-p]{32})/$') { $doctorExtId = $Matches[1] }
      foreach ($origin in @($manifest.allowed_origins)) {
        Write-Host "    allowed origin: $origin"
        if ($origin -notmatch '^chrome-extension://[a-p]{32}/$') { Write-WarnCheck "Origin '$origin' does not look like chrome-extension://<32 chars a-p>/. Compare it with the ID on chrome://extensions (Developer mode). A mismatch makes Chrome forbid the host." }
      }
    } else {
      Write-FailCheck 'Manifest has no allowed_origins.'
    }
  }
}

# ---------------------------------------------------- 5/6 Live protocol test
Write-Step '5/6 Live host test (framed PING over the real launch chain)'
$livePossible = $nodeReady -and (Test-Path $distEntry)
if ($livePossible) {
  $hostTestJs = Join-Path $env:TEMP 'x-pilot-doctor-host-test.js'
  $jsCode = @'
'use strict';
// X-Pilot Local Runner doctor: speaks the real Native Messaging framing
// (4-byte little-endian length + UTF-8 JSON) over stdin/stdout and expects a
// RESULT frame for PING. stdout is only ever read as protocol frames.
const { spawn } = require('node:child_process');
const path = require('node:path');
const runnerHome = process.argv[2];
const mode = process.argv[3]; // 'direct' | 'launcher' | 'exe'
const extId = process.argv[4]; // extension id for Chrome-style arguments

function frameRequest(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

function parseFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (buffer.length - offset >= 4) {
    const len = buffer.readUInt32LE(offset);
    if (len <= 0 || len > 1048576 || buffer.length - offset - 4 < len) break;
    try { frames.push(JSON.parse(buffer.subarray(offset + 4, offset + 4 + len).toString('utf8'))); } catch (e) { return frames; }
    offset += 4 + len;
  }
  return frames;
}

function launch() {
  if (mode === 'direct') {
    return spawn(process.execPath, [path.join(runnerHome, 'dist', 'index.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
  }
  if (mode === 'exe') {
    // Chrome's direct-launch path (LaunchContext::LaunchInBackground in
    // chrome/browser/extensions/api/messaging/launch_context.cc): the exe
    // receives the caller origin as the first argument and the
    // --parent-window handle argument. Reproduce that exact argv.
    const origin = 'chrome-extension://' + (extId || 'geppjelfpfleebmfgaiciiholmdliipn') + '/';
    return spawn(path.join(runnerHome, 'x-pilot-runner.exe'), [origin, '--parent-window=0'], { stdio: ['pipe', 'pipe', 'pipe'] });
  }
  return spawn('cmd.exe', ['/d', '/s', '/c', path.join(runnerHome, 'x-pilot-runner.cmd')], { stdio: ['pipe', 'pipe', 'pipe'] });
}

function exchange() {
  return new Promise((resolve) => {
    const child = launch();
    let out = Buffer.alloc(0);
    let stderrText = '';
    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { child.stdin.destroy(); } catch (e) {}
      try { child.kill(); } catch (e) {}
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: 'timed out after 30 seconds without a RESULT frame' }), 30000);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderrText += chunk; });
    child.stdout.on('data', (chunk) => {
      out = Buffer.concat([out, chunk]);
      const frames = parseFrames(out);
      for (const frame of frames) {
        if (frame && frame.type === 'RESULT') { finish({ ok: true, frame, stderr: stderrText }); return; }
      }
    });
    child.on('error', (e) => finish({ ok: false, reason: 'spawn failed: ' + e.message, stderr: stderrText }));
    child.on('close', (code) => finish({ ok: false, reason: 'host exited before responding (exit code ' + code + ')', stderr: stderrText }));
    const request = { protocolVersion: 1, requestId: 'doctor-' + process.pid + '-' + Date.now(), command: 'PING', workspaceId: 'doctor', profileId: 'doctor', issuedAt: Date.now() };
    try { child.stdin.write(frameRequest(request)); } catch (e) { finish({ ok: false, reason: 'stdin write failed: ' + e.message, stderr: stderrText }); }
  });
}

(async () => {
  const result = await exchange();
  if (!result.ok) {
    console.log('LIVE-TEST-FAIL: ' + result.reason);
    if (result.stderr && result.stderr.trim()) {
      console.log('HOST-STDERR-BEGIN');
      console.log(result.stderr.trim().split('\n').slice(-15).join('\n'));
      console.log('HOST-STDERR-END');
    }
    process.exit(1);
  }
  const frame = result.frame;
  if (frame.status !== 'OK' || frame.code !== 'RUNNER_OK' || !frame.result || frame.result.pong !== true) {
    console.log('LIVE-TEST-FAIL: unexpected PING response: status=' + frame.status + ' code=' + frame.code);
    process.exit(1);
  }
  console.log('LIVE-TEST-PASS: ' + mode + ' -> protocol ' + frame.protocolVersion + ' RESULT/RUNNER_OK/pong');
  process.exit(0);
})();
'@
  [System.IO.File]::WriteAllText($hostTestJs, $jsCode, (New-Object System.Text.ASCIIEncoding))
  try {
    Write-Host '  (a) direct: node dist\index.js'
    & node $hostTestJs $runnerHome direct 2>&1 | ForEach-Object { Write-Host "      $_" }
    if ($LASTEXITCODE -eq 0) { Write-Pass 'Host answered a framed PING when launched directly with node.' }
    else { Write-FailCheck 'Host did NOT answer a framed PING when launched directly (see HOST-STDERR above; usually a missing build or dependency).' }

    Write-Host '  (b) launcher: cmd.exe /c x-pilot-runner.cmd (legacy launch chain)'
    & node $hostTestJs $runnerHome launcher 2>&1 | ForEach-Object { Write-Host "      $_" }
    if ($LASTEXITCODE -eq 0) { Write-Pass 'Host answered a framed PING through the rendered .cmd launcher.' }
    else { Write-FailCheck 'Launcher test failed. If (a) passed, the .cmd layer is broken (node path moved?); see host-stderr.log below.' }

    Write-Host '  (c) chrome-style: x-pilot-runner.exe chrome-extension://<id>/ --parent-window=0 (the direct-launch path)'
    & node $hostTestJs $runnerHome exe $(if ($doctorExtId) { $doctorExtId } else { 'geppjelfpfleebmfgaiciiholmdliipn' }) 2>&1 | ForEach-Object { Write-Host "      $_" }
    if ($LASTEXITCODE -eq 0) { Write-Pass 'Host answered a framed PING through the compiled .exe with Chrome-style origin arguments (direct-launch path).' }
    else { Write-FailCheck 'Chrome-style .exe test failed. If (a) passed, the .exe launcher layer is broken (node resolution?); see HOST-STDERR above and host-stderr.log. Re-run install.ps1 to recompile it.' }
  } finally {
    Remove-Item -Path $hostTestJs -Force -ErrorAction SilentlyContinue | Out-Null
  }
} else {
  Write-WarnCheck 'Live host test skipped (Node.js or dist\index.js not available). Fix the failures above first.'
}

# -------------------------------------------------------------- 6/6 Logs
Write-Step '6/6 Recent runner logs'
$runnerLog = Join-Path $dataDir 'logs\runner.log'
$stderrLog = Join-Path $dataDir 'logs\host-stderr.log'
foreach ($pair in @(@('runner.log', $runnerLog), @('host-stderr.log (latest launch)', $stderrLog))) {
  $label = $pair[0]; $target = $pair[1]
  if (Test-Path $target) {
    Write-Host "  last lines of $label :"
    Get-Content -Path $target -Tail 12 | ForEach-Object { Write-Host "    $_" }
    if ($label -eq 'runner.log') {
      if (-not (Select-String -Path $target -Pattern 'X-Pilot Local Runner starting' -Quiet)) {
        Write-WarnCheck 'runner.log has no "X-Pilot Local Runner starting" line yet: the host process has never actually started on this machine.'
      }
      Write-Host '    hint: sessions with a "host process context" line carrying callerOrigin = chrome-extension://... were launched by Chrome; the shutdown detail reports framesReceived/responsesSent, so a session with framesReceived 0 never received a message.' -ForegroundColor DarkGray
    }
  } else {
    Write-WarnCheck "$label not found ($target)."
  }
}

Write-Host ''
if ($script:failures -gt 0) {
  Write-Host "RESULT: $script:failures check(s) FAILED. Fix them, re-run doctor, then retry Test Connection." -ForegroundColor Red
  exit 1
}
Write-Host 'RESULT: all checks passed. The launch chain Chrome uses is healthy.' -ForegroundColor Green
Write-Host 'If Chrome still shows "Error when communicating with the native messaging host.": fully restart Chrome (enter chrome://restart in the address bar) so it re-reads the registration, then retry Test Connection.' -ForegroundColor Green
exit 0
