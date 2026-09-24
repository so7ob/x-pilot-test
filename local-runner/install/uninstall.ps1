<#
.SYNOPSIS
  Unregisters and removes the X-Pilot Local Runner host registration.

.DESCRIPTION
  Removes the HKCU native messaging registration and the rendered host
  manifest + launcher. By DEFAULT login profiles and the duplicate-prevention
  ledger under %LOCALAPPDATA%\X-Pilot\Runner are PRESERVED. Pass -PurgeData to
  delete them as a separate, explicit action.

.PARAMETER PurgeData
  Optional. ALSO deletes %LOCALAPPDATA%\X-Pilot\Runner (login profiles and
  the operation ledger). This signs the runner out of X and removes local
  publish evidence. The action is irreversible.

.PARAMETER RemovePackage
  Optional. Also deletes the local-runner package folder itself.
#>

[CmdletBinding()]
param(
  [switch]$PurgeData,
  [switch]$RemovePackage,
  [string]$RunnerHome = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
$hostName = 'com.so7ob.x_pilot_runner'
$manifestsDir = Join-Path $env:LOCALAPPDATA 'X-Pilot\NativeMessagingHosts'
$manifestPath = Join-Path $manifestsDir "$hostName.json"
$registryKey = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
$dataDir = Join-Path $env:LOCALAPPDATA 'X-Pilot\Runner'

function Write-Step($message) { Write-Host "[X-Pilot Runner] $message" -ForegroundColor Cyan }
function Write-Ok($message) { Write-Host "  $message" -ForegroundColor Green }

Write-Step 'Removing the native messaging registration (HKCU)...'
if (Test-Path $registryKey) { Remove-Item -Path $registryKey -Recurse -Force; Write-Ok 'Registry key removed.' }
else { Write-Ok 'Registry key was not present.' }

if (Test-Path $manifestPath) { Remove-Item -Path $manifestPath -Force; Write-Ok "Manifest removed: $manifestPath" }
else { Write-Ok 'Manifest was not present.' }

$launcher = Join-Path $RunnerHome 'x-pilot-runner.cmd'
if (Test-Path $launcher) { Remove-Item -Path $launcher -Force; Write-Ok 'Rendered launcher removed.' }

if ($PurgeData) {
  Write-Step 'Purging login profiles and the operation ledger (explicit -PurgeData)...'
  if (Test-Path $dataDir) { Remove-Item -Path $dataDir -Recurse -Force; Write-Ok "Data removed: $dataDir" }
  else { Write-Ok 'No data directory existed.' }
} else {
  Write-Step 'Login profiles and the operation ledger are KEPT (default).'
  Write-Ok "Data preserved at: $dataDir (delete explicitly with -PurgeData)"
}

if ($RemovePackage) {
  Write-Step 'Removing the runner package...'
  if (Test-Path $RunnerHome) { Remove-Item -Path $RunnerHome -Recurse -Force; Write-Ok "Package removed: $RunnerHome" }
}

Write-Ok 'Uninstall complete. Chrome must be restarted for open native hosts to exit.'
