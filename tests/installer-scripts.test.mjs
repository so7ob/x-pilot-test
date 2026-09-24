import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const installDir = path.join(root, 'local-runner', 'install');
const scripts = ['install.ps1', 'uninstall.ps1', 'repair.ps1'];

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
