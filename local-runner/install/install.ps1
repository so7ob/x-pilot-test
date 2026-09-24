<#
.SYNOPSIS
  Installs the X-Pilot Local Runner native messaging host for the current user.

.DESCRIPTION
  - Verifies prerequisites (Node.js >= 20).
  - Installs runner dependencies and builds dist/index.js.
  - Optionally downloads the Playwright Chromium browser (use -SkipBrowserDownload to skip).
  - Renders x-pilot-runner.cmd (ASCII-only; resolves its own path at runtime, so
    install paths containing spaces or Arabic characters are safe). The launcher
    captures host stderr into %LOCALAPPDATA%\X-Pilot\Runner\logs\host-stderr.log
    (stdout stays reserved for the native messaging protocol).
  - Renders the native messaging host manifest with the REAL extension id and
    registers it under HKCU (per-user, no admin required). The manifest is
    written UTF-8 WITHOUT a BOM and byte-verified, because Windows PowerShell
    5.1 `Set-Content -Encoding UTF8` always prepends EF BB BF, which Chrome's
    JSON reader rejects (issue #6).
  - Login profiles live under %LOCALAPPDATA%\X-Pilot\Runner and are NEVER
    written inside the repository.
  - After install, run install\doctor.ps1 any time to verify the whole chain
    (registry, manifest, launcher, live framed PING) without opening Chrome.

.PARAMETER ExtensionId
  REQUIRED. The Chrome extension id of the X-Pilot build you will connect.
  Find it on chrome://extensions after loading the unpacked dist/ folder.
  No wildcards are ever written; only this exact origin is allowed.

.PARAMETER RunnerHome
  Optional. Directory containing this runner package. Defaults to the script
  location's parent (the local-runner folder).

.PARAMETER SkipBrowserDownload
  Optional. Skips `npx playwright install chromium`. The runner needs a
  Playwright Chromium build; download it separately if skipped.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -ExtensionId abcdefghijklmnopqrstuvwxyzabcdef
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-p]{32}$')]
  [string]$ExtensionId,

  [string]$RunnerHome = '',

  [switch]$SkipBrowserDownload
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

function Write-Step($message) { Write-Host "[X-Pilot Runner] $message" -ForegroundColor Cyan }
function Write-Ok($message) { Write-Host "  $message" -ForegroundColor Green }
function Write-Fail($message) { Write-Host "  $message" -ForegroundColor Red; exit 1 }

Write-Step 'Checking prerequisites (Windows 10/11 x64, Node.js >= 20)...'
if (-not ($env:OS -match 'Windows_NT')) { Write-Fail 'This installer targets Windows.' }
try { $nodeVersion = (node --version) } catch { Write-Fail 'Node.js was not found on PATH. Install Node.js LTS 20+ from https://nodejs.org first.' }
$nodeMajor = [int]($nodeVersion -replace '^v(\d+).*$', '$1')
if ($nodeMajor -lt 20) { Write-Fail "Node.js >= 20 is required (found $nodeVersion)." }
Write-Ok "Node.js $nodeVersion detected."

Write-Step 'Checking runner package...'
$runnerHome = [System.IO.Path]::GetFullPath($RunnerHome)
if (-not (Test-Path (Join-Path $runnerHome 'package.json'))) { Write-Fail "Runner package not found at '$runnerHome'. Pass -RunnerHome <path to local-runner>." }
$runnerHomeUnc = $runnerHome -replace '\\', '\\'
Write-Ok "Runner home: $runnerHome"

Write-Step 'Installing dependencies (npm install)...'
Push-Location $runnerHome
try {
  npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { Write-Fail 'npm install failed.' }
  Write-Ok 'Dependencies installed.'

  Write-Step 'Building the runner (tsc + esbuild -> dist/index.js)...'
  npm run build
  if ($LASTEXITCODE -ne 0) { Write-Fail 'Build failed.' }
  if (-not (Test-Path (Join-Path $runnerHome 'dist\index.js'))) { Write-Fail 'dist/index.js was not produced.' }
  Write-Ok 'Build succeeded.'

  if (-not $SkipBrowserDownload) {
    Write-Step 'Downloading the Playwright Chromium browser (~100-170 MB, first time only)...'
    npx playwright install chromium
    if ($LASTEXITCODE -ne 0) { Write-Fail 'Chromium download failed. Re-run with -SkipBrowserDownload and install it manually.' }
    Write-Ok 'Chromium is ready.'
  } else {
    Write-Ok 'Browser download skipped on request. Ensure `npx playwright install chromium` was run.'
  }
} finally { Pop-Location }

Write-Step 'Rendering the launcher (ASCII-only, runtime path resolution)...'
$launcherPath = Join-Path $runnerHome 'x-pilot-runner.cmd'
$template = Get-Content (Join-Path $PSScriptRoot 'x-pilot-runner.cmd.template') -Raw
# Prefer the absolute node.exe path when it is pure ASCII (cmd parses the file
# in the ANSI codepage); fall back to PATH lookup for non-ASCII node paths.
$nodeCommand = (Get-Command node -ErrorAction Stop).Source
$nodeAscii = $nodeCommand -match '^[\x00-\x7F]+$'
$rendered = $template.Replace('__NODE_EXE__', $(if ($nodeAscii) { $nodeCommand } else { 'node' }))
Set-Content -Path $launcherPath -Value $rendered -Encoding Ascii
Write-Ok "Launcher: $launcherPath"

Write-Step 'Registering the native messaging host (per-user, HKCU)...'
New-Item -ItemType Directory -Path $manifestsDir -Force | Out-Null
$allowedOrigin = "chrome-extension://$ExtensionId/"
$manifest = [ordered]@{
  name        = $hostName
  description = 'X-Pilot Local Runner - drives a dedicated headless Chromium to execute X-Pilot publishing operations.'
  path        = $launcherPath
  type        = 'stdio'
  allowed_origins = @($allowedOrigin)
}
$manifestJson = $manifest | ConvertTo-Json -Depth 3

# Chrome reads the host manifest with a strict JSON reader that REJECTS a
# UTF-8 BOM. Windows PowerShell 5.1 `Set-Content -Encoding UTF8` ALWAYS
# prepends EF BB BF, which made every connectNative fail with "Error when
# communicating with the native messaging host." (issue #6). The file is
# therefore written through .NET with an explicitly BOM-less encoder. Do NOT
# switch this back to Set-Content in any PowerShell edition.
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($manifestPath, $manifestJson, $utf8NoBom)

# Self-verification: reject a BOM, re-parse the JSON, and confirm every field
# Chrome needs before declaring success. A broken registration must fail
# loudly here instead of silently at Test Connection time.
$rawBytes = [System.IO.File]::ReadAllBytes($manifestPath)
if ($rawBytes.Length -ge 3 -and $rawBytes[0] -eq 0xEF -and $rawBytes[1] -eq 0xBB -and $rawBytes[2] -eq 0xBF) {
  Write-Fail 'Manifest was written with a UTF-8 BOM, which Chrome rejects. Installer bug - please report it at https://github.com/so7ob/x-pilot-test/issues.'
}
$roundTrip = ([System.IO.File]::ReadAllText($manifestPath, $utf8NoBom) | ConvertFrom-Json)
if ($roundTrip.name -ne $hostName) { Write-Fail "Manifest self-check failed: name is '$($roundTrip.name)' (expected '$hostName')." }
if ($roundTrip.type -ne 'stdio') { Write-Fail "Manifest self-check failed: type is '$($roundTrip.type)' (expected 'stdio')." }
if ($roundTrip.path -ne $launcherPath) { Write-Fail 'Manifest self-check failed: path does not match the rendered launcher.' }
if (-not (Test-Path $roundTrip.path)) { Write-Fail "Manifest self-check failed: host launcher not found at '$($roundTrip.path)'." }
if ($roundTrip.allowed_origins -notcontains $allowedOrigin) { Write-Fail 'Manifest self-check failed: allowed_origins is missing the extension origin.' }
Write-Ok 'Manifest verified: UTF-8 without BOM, valid JSON, required fields, launcher present.'

# Register the HKCU default value through the .NET Registry API (explicit and
# unambiguous across PowerShell editions) and READ IT BACK to prove that
# Chrome will resolve exactly this manifest path.
$registryHandle = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($registrySubKey)
$registryHandle.SetValue('', $manifestPath, [Microsoft.Win32.RegistryValueKind]::String)
$registryHandle.Close()
$registryReadBack = ([Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($registrySubKey)).GetValue('')
if ($registryReadBack -ne $manifestPath) { Write-Fail "Registry self-check failed: default value read back as '$registryReadBack' (expected '$manifestPath')." }
Write-Ok "Manifest: $manifestPath"
Write-Ok "Registry: HKCU\$registrySubKey (default) -> $manifestPath"
Write-Ok "Allowed origin: $allowedOrigin (exact id, no wildcards)"

Write-Step 'Done.'
Write-Host ''
Write-Host 'Next steps:' -ForegroundColor Yellow
Write-Host '  1. Load the X-Pilot extension (repository dist/ folder) in chrome://extensions.'
Write-Host "     It must have the extension id you passed: $ExtensionId"
Write-Host '  2. Open X-Pilot Side Panel -> Settings -> Local Runner, press Test Connection.'
Write-Host '  3. Press "Set up login" once, sign in inside the opened window, and close it.'
Write-Host '  4. Select the LOCAL RUNNER engine and run Preflight / Dry Run.'
Write-Host '  5. If Test Connection fails, run install\doctor.ps1 for a full diagnosis'
Write-Host '     (registry, manifest, launcher, live framed PING, log tails).'
Write-Host ''
Write-Host 'Login profiles and the duplicate-prevention ledger live in:' -ForegroundColor Yellow
Write-Host "  $env:LOCALAPPDATA\X-Pilot\Runner"
Write-Host '  They are kept OUTSIDE the repository and are NOT removed by uninstall.ps1 by default.'
