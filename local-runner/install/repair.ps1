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

  [string]$RunnerHome = (Split-Path -Parent $PSScriptRoot),

  [switch]$SkipBrowserDownload
)

$ErrorActionPreference = 'Stop'
Write-Host '[X-Pilot Runner] Repairing installation...' -ForegroundColor Cyan
$installScript = Join-Path $PSScriptRoot 'install.ps1'
& $installScript -ExtensionId $ExtensionId -RunnerHome $RunnerHome -SkipBrowserDownload:($SkipBrowserDownload.IsPresent)
if ($LASTEXITCODE -ne 0) { Write-Host '  Repair failed.' -ForegroundColor Red; exit 1 }
Write-Host '[X-Pilot Runner] Repair complete. Login data was preserved.' -ForegroundColor Green
