import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const engine = fs.readFileSync(path.join(root, 'src/background/automation-engine.ts'), 'utf8');
const serviceWorker = fs.readFileSync(path.join(root, 'src/background/service-worker.ts'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'public/manifest.json'), 'utf8'));

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/([^:\w])\/\/.*$/gm, '$1');
}

function sliceFrom(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `marker not found: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.ok(end > start, `end marker not found after ${startMarker}: ${endMarker}`);
  return stripComments(source.slice(start, end));
}

test('LOCAL_RUNNER publish branch never touches chrome.tabs (no X tab in the daily browser)', () => {
  const branch = sliceFrom(engine, "if (executionBackend === 'LOCAL_RUNNER') {", 'tabId = await getOrCreateAutomationTab(session);');
  for (const forbidden of ['chrome.tabs', 'getOrCreateAutomationTab', 'activateAutomationTab', 'waitForTabLoad', 'getPreviousActiveTabId', 'chrome.scripting']) {
    assert.equal(branch.includes(forbidden), false, `runner branch must not contain ${forbidden}`);
  }
  for (const required of ['localRunnerBridge.inspect', 'localRunnerBridge.publish', 'publishIntentId: operationId', 'assertOperationActive']) {
    assert.equal(branch.includes(required), true, `runner branch must contain ${required}`);
  }
});

test('LOCAL_RUNNER preflight branch never opens a Chrome tab', () => {
  const preflight = sliceFrom(engine, 'export async function performPreflight(workspaceId: string) {', 'export async function scheduleSession(');
  const branch = sliceFrom(preflight, "if (executionBackend === 'LOCAL_RUNNER') {", '} else {');
  for (const forbidden of ['chrome.tabs', 'inspectTab', 'activateAutomationTab', 'waitForTabLoad']) {
    assert.equal(branch.includes(forbidden), false, `runner preflight must not contain ${forbidden}`);
  }
  assert.equal(branch.includes('localRunnerBridge.inspect'), true);
});

test('LOCAL_RUNNER dry-run branch never opens a Chrome tab and never publishes', () => {
  const dryRun = sliceFrom(serviceWorker, "async function runDryRun(mode: 'FIRST_ITEM' | 'ENTIRE_QUEUE', workspaceId?: string)", 'async function extractBank(');
  const branch = sliceFrom(dryRun, "if (executionBackend === 'LOCAL_RUNNER') {", 'if (state.session) {');
  for (const forbidden of ['chrome.tabs', 'getOrCreateAutomationTab', 'X_PUBLISH']) {
    assert.equal(branch.includes(forbidden), false, `runner dry-run must not contain ${forbidden}`);
  }
  assert.equal(branch.includes('localRunnerBridge.inspect'), true);
});

test('LOCAL_RUNNER diagnostics branch never opens a Chrome tab', () => {
  const diagnostics = sliceFrom(serviceWorker, 'async function runDiagnostics(): Promise<DiagnosticsResult> {', 'function classifyDryRunInspection(');
  const branch = sliceFrom(diagnostics, "if (executionBackend === 'LOCAL_RUNNER') {", '} else {');
  for (const forbidden of ['chrome.tabs', 'inspectTab', 'waitForTabLoad']) {
    assert.equal(branch.includes(forbidden), false, `runner diagnostics must not contain ${forbidden}`);
  }
});

test('the engine has NO implicit fallback from LOCAL_RUNNER to CHROME_TAB', () => {
  // The backend is resolved once from the pinned session; no code path may
  // reassign or downgrade it after a runner failure.
  const stripped = stripComments(engine);
  const assignments = stripped.match(/executionBackend\s*=\s*[^=]/g) ?? [];
  assert.equal(assignments.length, 1, 'executionBackend must be assigned exactly once (resolveSessionBackend)');
  assert.match(engine, /const executionBackend = resolveSessionBackend\(session, settings\);/);
  // Reconciliation (not blind retries) owns post-disconnect state.
  assert.match(engine, /reconcileInterruptedRunnerOperations/);
});

test('runner failures surface distinct codes instead of a generic error', () => {
  for (const code of ['RUNNER_LOGIN_REQUIRED', 'RUNNER_CHALLENGE', 'RUNNER_ACCOUNT_MISMATCH', 'RUNNER_ACCOUNT_UNKNOWN', 'RUNNER_CONTENT_MISMATCH']) {
    assert.equal(engine.includes(code), true, `engine must surface ${code}`);
  }
  // Distinct user-facing messages exist for each state at the UI boundary.
  const errorMessages = fs.readFileSync(path.join(root, 'src/ui/services/error-messages.ts'), 'utf8');
  for (const code of ['RUNNER_NOT_INSTALLED', 'RUNNER_LAUNCH_FAILED', 'RUNNER_PROTOCOL_MISMATCH', 'RUNNER_LOGIN_REQUIRED', 'RUNNER_PROFILE_LOCKED', 'RUNNER_ACCOUNT_MISMATCH', 'RUNNER_DISCONNECTED']) {
    assert.equal(errorMessages.includes(code), true, `error-messages must map ${code}`);
  }
});

test('manifest declares nativeMessaging and no credential permissions', () => {
  assert.equal(manifest.permissions.includes('nativeMessaging'), true);
  const all = [...(manifest.permissions ?? []), ...(manifest.host_permissions ?? [])];
  assert.equal(all.includes('cookies'), false);
  assert.equal(all.includes('webRequest'), false);
  assert.equal(all.includes('debugger'), false);
});

test('the runner bridge is the only connectNative caller', () => {
  const bridge = fs.readFileSync(path.join(root, 'src/runner/local-runner-bridge.ts'), 'utf8');
  assert.match(bridge, /chrome\.runtime\.connectNative\(hostName\)/);
  assert.equal(serviceWorker.includes('connectNative'), false, 'service worker must go through the bridge');
  assert.equal(engine.includes('connectNative'), false, 'engine must go through the bridge');
});

test('publish intent is persisted before the runner submit (same invariant as the tab flow)', () => {
  const branch = sliceFrom(engine, "if (executionBackend === 'LOCAL_RUNNER') {", 'tabId = await getOrCreateAutomationTab(session);');
  const intentIndex = branch.indexOf("publishIntentId: operationId");
  const publishIndex = branch.indexOf('localRunnerBridge.publish(');
  assert.ok(intentIndex >= 0 && publishIndex > intentIndex, 'publishIntentId must be persisted before the runner publish command');
});

test('pause/stop send runner CANCEL only as advisory pre-submit cancellation', () => {
  assert.match(engine, /cancelInFlightRunnerOperation\(\)/);
  const cancelFn = sliceFrom(engine, 'async function cancelInFlightRunnerOperation', 'export async function pauseSession');
  assert.match(cancelFn, /localRunnerBridge\.cancel/);
  assert.match(cancelFn, /catch \{/);
});
test('UPDATE_SETTINGS cannot switch the engine of a running session', () => {
  assert.match(serviceWorker, /const \{ executionBackend: _pinnedExcluded, \.\.\.sessionApplicable \} = message\.settings/);
});

test('recovery queries the runner ledger before the conservative domain fallback', () => {
  assert.match(engine, /reconcileInterruptedRunnerOperations\(current\)/);
  const reconcile = sliceFrom(engine, 'export async function reconcileInterruptedRunnerOperations', 'export async function recoverPersistedState');
  assert.match(reconcile, /getOperation/);
  assert.match(reconcile, /continue;\s*\}\s*if \(!record\) continue;/, 'unreachable runner must keep the conservative state');
});

test('workspace expected account is validated before storage', () => {
  const storage = fs.readFileSync(path.join(root, 'src/storage/storage-repository.ts'), 'utf8');
  assert.match(storage, /normalizeAccountHandle/);
  assert.match(storage, /WORKSPACE_EXPECTED_ACCOUNT_INVALID/);
});

test('the runner UI card exists in Settings with i18n keys only (AR + EN)', () => {
  const card = fs.readFileSync(path.join(root, 'src/ui/components/local-runner-card.tsx'), 'utf8');
  assert.match(card, /RUNNER_TEST/);
  assert.match(card, /RUNNER_SETUP_LOGIN/);
  assert.match(card, /expectedAccountDraft/);
  const en = fs.readFileSync(path.join(root, 'src/i18n/en.ts'), 'utf8');
  const ar = fs.readFileSync(path.join(root, 'src/i18n/ar.ts'), 'utf8');
  for (const key of ['runner.title', 'runner.engine', 'runner.testConnection', 'runner.setupLogin', 'runner.states.NOT_INSTALLED', 'errors.runnerAccountMismatch']) {
    const pathKey = key.split('.').pop();
    assert.equal(en.includes(pathKey), true, `en missing ${key}`);
    assert.equal(ar.includes(pathKey), true, `ar missing ${key}`);
  }
});
