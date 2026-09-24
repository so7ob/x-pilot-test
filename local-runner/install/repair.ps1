<#
.SYNOPSIS
  Repairs an existing X-Pilot Local Runner installation.

.DESCRIPTION
  Re-runs dependency install + build, re-renders the launcher, and re-registers
  the host manifest. Use after a Chrome extension reload that produced a NEW
  extension id, or after fixing a broken build. Existing login profiles and
  the duplicate-prevention ledger are untouched.
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
Write-Host '[X-Pilot Runner] Repairing installation...' -ForegroundColor Cyan
$installScript = Join-Path $PSScriptRoot 'install.ps1'
& $installScript -ExtensionId $ExtensionId -RunnerHome $RunnerHome -SkipBrowserDownload:($SkipBrowserDownload.IsPresent)
if ($LASTEXITCODE -ne 0) { Write-Host '  Repair failed.' -ForegroundColor Red; exit 1 }
Write-Host '[X-Pilot Runner] Repair complete. Login data was preserved.' -ForegroundColor Green
