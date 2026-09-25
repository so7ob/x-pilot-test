import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const engineSource = fs.readFileSync(path.join(root, 'src/background/automation-engine.ts'), 'utf8');
const serviceWorkerSource = fs.readFileSync(path.join(root, 'src/background/service-worker.ts'), 'utf8');
const preflightDomainSource = fs.readFileSync(path.join(root, 'src/domain/preflight.ts'), 'utf8');
const operationCardsSource = fs.readFileSync(path.join(root, 'src/ui/components/operation-cards.tsx'), 'utf8');
const arSource = fs.readFileSync(path.join(root, 'src/i18n/ar.ts'), 'utf8');
const enSource = fs.readFileSync(path.join(root, 'src/i18n/en.ts'), 'utf8');

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

/** Installs a chrome mock sufficient to import the automation engine and
 * exercise the exported tab-readiness helpers. The `tab` object is mutable so
 * tests can simulate navigation state transitions. */
function installChromeMock({ tab, onSendMessage, onExecuteScript } = {}) {
  const calls = { sendMessage: 0, executeScript: 0 };
  globalThis.chrome = {
    tabs: {
      onUpdated: { addListener: () => undefined },
      onRemoved: { addListener: () => undefined },
      get: async () => tab,
      query: async () => [],
      create: async (options) => ({ id: 1, ...options }),
      update: async () => ({}),
      remove: async () => undefined,
      sendMessage: async (tabId, message) => {
        calls.sendMessage += 1;
        return onSendMessage(calls.sendMessage, message);
      },
    },
    scripting: {
      executeScript: async (options) => {
        calls.executeScript += 1;
        return onExecuteScript ? onExecuteScript(options) : [];
      },
    },
    runtime: { getManifest: () => ({ version: '1.5.6' }), sendMessage: async () => undefined },
    alarms: { onAlarm: { addListener: () => undefined }, create: async () => undefined, clear: async () => undefined },
    storage: { local: { get: async () => ({}), set: async () => undefined, remove: async () => undefined } },
  };
  return calls;
}

const okInspection = { ok: true, pageKind: 'X', composerFound: true, contentPresent: true, postButtonFound: true, postButtonEnabled: true };
const unknownInspection = { ok: false, pageKind: 'UNKNOWN', composerFound: false, contentPresent: false, postButtonFound: false, postButtonEnabled: false, reason: 'WRONG_HOST' };
const loginInspection = { ok: false, pageKind: 'LOGIN', composerFound: false, contentPresent: false, postButtonFound: false, postButtonEnabled: false, reason: 'NOT_LOGGED_IN' };

async function importEngine() {
  // The engine registers tab-lifecycle listeners at module scope, so a chrome
  // mock must exist before the (cached) import. Tests that need specific
  // behavior install their own mock first — the engine resolves the global
  // `chrome` at call time, so later mocks take over.
  if (!globalThis.chrome) installChromeMock({ tab: { id: 1, status: 'complete', url: 'about:blank' } });
  return import('../src/background/automation-engine.ts?tab-readiness-test');
}

test('X_TAB_URL_PATTERN matches X hosts on http(s) and rejects everything else', async () => {
  const { X_TAB_URL_PATTERN } = await importEngine();
  for (const url of ['https://x.com/home', 'http://x.com/intent/post?text=hi', 'https://www.x.com/i/flow/login', 'https://twitter.com/home', 'https://mobile.twitter.com/compose/post']) {
    assert.equal(X_TAB_URL_PATTERN.test(url), true, `must match ${url}`);
  }
  for (const url of ['about:blank', 'https://google.com/', 'chrome-error://chromewebdata/', 'ftp://x.com/', '']) {
    assert.equal(X_TAB_URL_PATTERN.test(url), false, `must reject ${url}`);
  }
});

test('TRIPWIRE (issue #18): waitForTabLoad with a URL gate never resolves on a complete about:blank tab', async () => {
  // The v1.5.5 implementation resolved on the first "complete" status it saw —
  // including the stale about:blank one that precedes the X navigation commit —
  // so the first X_INSPECT landed on a page with no content script and the
  // preflight reported "X Adapter did not recognize the page". This test fails
  // on that implementation and passes on the URL-gated poll.
  installChromeMock({ tab: { id: 7, status: 'complete', url: 'about:blank' } });
  const { waitForTabLoad, X_TAB_URL_PATTERN } = await importEngine();
  await assert.rejects(() => waitForTabLoad(7, 700, { urlMatches: X_TAB_URL_PATTERN }), /TAB_LOAD_TIMEOUT/);
});

test('waitForTabLoad with a URL gate resolves once the tab commits an X page', async () => {
  const tab = { id: 8, status: 'loading', url: 'about:blank', pendingUrl: 'https://x.com/intent/post?text=hello' };
  installChromeMock({ tab });
  const { waitForTabLoad, X_TAB_URL_PATTERN } = await importEngine();
  setTimeout(() => { tab.pendingUrl = undefined; tab.status = 'complete'; tab.url = 'https://x.com/intent/post?text=hello'; }, 120);
  await waitForTabLoad(8, 3_000, { urlMatches: X_TAB_URL_PATTERN });
  assert.equal(tab.url, 'https://x.com/intent/post?text=hello');
});

test('waitForTabLoad with a URL gate refuses a tab whose navigation is still pending (pendingUrl set)', async () => {
  const tab = { id: 9, status: 'complete', url: 'https://x.com/old', pendingUrl: 'https://x.com/new' };
  installChromeMock({ tab });
  const { waitForTabLoad, X_TAB_URL_PATTERN } = await importEngine();
  await assert.rejects(() => waitForTabLoad(9, 700, { urlMatches: X_TAB_URL_PATTERN }), /TAB_LOAD_TIMEOUT/);
});

test('waitForTabLoad without a URL gate keeps legacy semantics (resolves on complete)', async () => {
  installChromeMock({ tab: { id: 10, status: 'complete', url: 'https://example.com/bank' } });
  const { waitForTabLoad } = await importEngine();
  await waitForTabLoad(10, 500);
});

test('waitForTabUrlChange resolves once the committed URL moves away from the previous one, and times out silently', async () => {
  const tab = { id: 11, status: 'complete', url: 'https://x.com/intent/post?text=a' };
  installChromeMock({ tab });
  const { waitForTabUrlChange } = await importEngine();
  setTimeout(() => { tab.url = 'https://x.com/intent/post?text=b'; }, 100);
  await waitForTabUrlChange(11, 'https://x.com/intent/post?text=a', 2_000);
  // Never changes → silent timeout (best-effort settle, not an error).
  await waitForTabUrlChange(11, 'https://x.com/intent/post?text=b', 300);
});

test('TRIPWIRE (issue #18): inspectTabUntilStable retries past a transient UNKNOWN classification (the exact v1.5.5 user symptom)', async () => {
  // A single early X_INSPECT returned UNKNOWN (the page was still committing);
  // the v1.5.5 preflight took it as final and failed the startup tests.
  let attempt = 0;
  installChromeMock({ tab: { id: 12, status: 'complete', url: 'https://x.com/intent/post?text=hello' }, onSendMessage: () => { attempt += 1; return attempt === 1 ? unknownInspection : okInspection; } });
  const { inspectTabUntilStable } = await importEngine();
  const inspection = await inspectTabUntilStable(12, 3_000, 50);
  assert.equal(inspection.pageKind, 'X');
  assert.equal(inspection.ok, true);
  assert.equal(attempt, 2);
});

test('inspectTabUntilStable recovers when the content script registers late (sendMessage fails, then executeScript fallback succeeds)', async () => {
  let registered = false;
  const calls = installChromeMock({
    tab: { id: 13, status: 'complete', url: 'https://x.com/intent/post?text=hello' },
    onSendMessage: () => { if (!registered) throw new Error('Could not establish connection. Receiving end does not exist.'); return okInspection; },
    onExecuteScript: () => { registered = true; return []; },
  });
  const { inspectTabUntilStable } = await importEngine();
  const inspection = await inspectTabUntilStable(13, 3_000, 50);
  assert.equal(inspection.ok, true);
  assert.equal(calls.executeScript >= 1, true, 'the injection fallback must have run');
});

test('inspectTabUntilStable returns LOGIN immediately instead of polling a definite state', async () => {
  const calls = installChromeMock({ tab: { id: 14, status: 'complete', url: 'https://x.com/i/flow/login' }, onSendMessage: () => loginInspection });
  const { inspectTabUntilStable } = await importEngine();
  const inspection = await inspectTabUntilStable(14, 3_000, 50);
  assert.equal(inspection.pageKind, 'LOGIN');
  assert.equal(calls.sendMessage, 1);
});

test('inspectTabUntilStable returns the last (not-ready) classification at the deadline instead of throwing', async () => {
  const notReady = { ok: false, pageKind: 'X', composerFound: false, contentPresent: false, postButtonFound: false, postButtonEnabled: false, reason: 'PUBLISH_CONTROLS_NOT_READY' };
  installChromeMock({ tab: { id: 15, status: 'complete', url: 'https://x.com/intent/post?text=hello' }, onSendMessage: () => notReady });
  const { inspectTabUntilStable } = await importEngine();
  const inspection = await inspectTabUntilStable(15, 350, 50);
  assert.equal(inspection.pageKind, 'X');
  assert.equal(inspection.reason, 'PUBLISH_CONTROLS_NOT_READY');
});

test('inspectTabUntilStable rethrows the underlying injection failure when the script can never load', async () => {
  // When BOTH the sendMessage and the executeScript fallback fail, the
  // injection error is the actionable root cause (page not accessible to the
  // extension) — it becomes the x-adapter reason shown to the user.
  installChromeMock({
    tab: { id: 16, status: 'complete', url: 'https://x.com/intent/post?text=hello' },
    onSendMessage: () => { throw new Error('Could not establish connection. Receiving end does not exist.'); },
    onExecuteScript: () => { throw new Error('Cannot access contents of the page'); },
  });
  const { inspectTabUntilStable } = await importEngine();
  await assert.rejects(() => inspectTabUntilStable(16, 300, 50), /Cannot access contents of the page/);
});

// ---------------------------------------------------------------------------
// Domain: the x-adapter check now explains WHY it failed and hints per engine.
// ---------------------------------------------------------------------------

const { runPreflight } = await import('../src/domain/preflight.ts');
const workspace = { id: 'ws-1', name: 'Campaign', description: '', favorite: false, archived: false, createdAt: 1, updatedAt: 1, lastActivityAt: 1 };
const bank = { id: 'bank-1', workspaceId: 'ws-1', name: 'Bank', url: 'https://example.com/bank', favorite: false, archived: false, createdAt: 1, updatedAt: 1 };
const baseSettings = { intervalMinutes: 2, maxRetries: 2, failureBehavior: 'CONTINUE', confirmBeforeStart: true, keepAutomationTabOpen: true, closeTabOnComplete: false, duplicatePolicy: 'BLOCK' };
const runnableItem = { id: 'item-1', workspaceId: 'ws-1', sourceBankId: 'bank-1', sourceBankUrl: bank.url, targetUrl: 'https://x.com/intent/post?text=hello', position: 1, status: 'PENDING', attempts: 0, createdAt: 1, updatedAt: 1 };

function preflightBase(xInspection, backend) {
  return runPreflight({ workspace, queue: [runnableItem], banks: [bank], alarmsAvailable: true, permissionsGranted: true, settings: baseSettings, xInspection, backend });
}

test('runPreflight surfaces the adapter failure reason (pageKind UNKNOWN/ERROR) and stays blocking', () => {
  const result = preflightBase({ ...unknownInspection, reason: 'Could not establish connection. Receiving end does not exist.' }, 'CHROME_TAB');
  const check = result.checks.find((candidate) => candidate.id === 'x-adapter');
  assert.equal(check.status, 'FAIL');
  assert.equal(check.messageKey, 'preflight.adapter');
  assert.equal(check.detailsKey, 'preflight.adapterReason');
  assert.equal(check.params.reason, 'Could not establish connection. Receiving end does not exist.');
  assert.equal(check.blocking, true);
  assert.equal(result.ready, false);
});

test('runPreflight default reason when the inspection carries none', () => {
  const result = preflightBase({ pageKind: 'ERROR', composerFound: false, contentPresent: false, postButtonFound: false, postButtonEnabled: false }, 'CHROME_TAB');
  const check = result.checks.find((candidate) => candidate.id === 'x-adapter');
  assert.equal(check.detailsKey, 'preflight.adapterReason');
  assert.equal(check.params.reason, 'UNKNOWN_PAGE');
});

test('runPreflight login hint differs per execution engine', () => {
  const chromeTab = preflightBase(loginInspection, 'CHROME_TAB').checks.find((candidate) => candidate.id === 'x-adapter');
  assert.equal(chromeTab.detailsKey, 'preflight.loginChromeTabHint');
  const runner = preflightBase(loginInspection, 'LOCAL_RUNNER').checks.find((candidate) => candidate.id === 'x-adapter');
  assert.equal(runner.detailsKey, 'preflight.loginRunnerHint');
  const unspecified = preflightBase(loginInspection, undefined).checks.find((candidate) => candidate.id === 'x-adapter');
  assert.equal(unspecified.detailsKey, undefined);
  for (const check of [chromeTab, runner, unspecified]) assert.equal(check.blocking, true);
});

test('runPreflight composer failure carries its reason too', () => {
  const result = preflightBase({ pageKind: 'X', composerFound: false, contentPresent: false, postButtonFound: true, postButtonEnabled: true, reason: 'PUBLISH_CONTROLS_NOT_READY' }, 'LOCAL_RUNNER');
  const check = result.checks.find((candidate) => candidate.id === 'x-adapter');
  assert.equal(check.messageKey, 'preflight.composer');
  assert.equal(check.detailsKey, 'preflight.adapterReason');
  assert.equal(check.params.reason, 'PUBLISH_CONTROLS_NOT_READY');
});

// ---------------------------------------------------------------------------
// Source contracts: the brittle v1.5.5 wiring is gone from every surface.
// ---------------------------------------------------------------------------

test('the CHROME_TAB preflight branch has no about:blank dance and no single-shot 300ms probe', () => {
  const branch = sliceFrom(engineSource, 'const temporary = await chrome.tabs.create({ url: targetUrl, active: false });', 'export async function scheduleSession(');
  for (const forbidden of ["url: 'about:blank'", 'chrome.tabs.update(temporary.id', 'await wait(300)', 'xInspection = await inspectTab(temporary.id)']) {
    assert.equal(branch.includes(forbidden), false, `preflight branch must not contain ${forbidden}`);
  }
  for (const required of ['waitForTabLoad(temporary.id, 20_000, { urlMatches: X_TAB_URL_PATTERN })', 'inspectTabUntilStable(temporary.id)']) {
    assert.equal(branch.includes(required), true, `preflight branch must contain ${required}`);
  }
});

test('the dry-run loop uses URL settle + gated load + stable inspection (no 300ms single probe)', () => {
  const branch = sliceFrom(serviceWorkerSource, 'async function runDryRun(', 'async function extractBank(');
  for (const forbidden of ['await wait(300)', 'const inspection = await inspectTab(tabId)']) {
    assert.equal(branch.includes(forbidden), false, `dry-run must not contain ${forbidden}`);
  }
  for (const required of ['waitForTabUrlChange(tabId, previousTabUrl)', 'waitForTabLoad(tabId, 20_000, { urlMatches: X_TAB_URL_PATTERN })', 'inspectTabUntilStable(tabId)']) {
    assert.equal(branch.includes(required), true, `dry-run must contain ${required}`);
  }
});

test('the diagnostics inspection is stable and its temporary-tab load wait is URL-gated', () => {
  const branch = sliceFrom(serviceWorkerSource, 'async function runDiagnostics(): Promise<DiagnosticsResult> {', 'function classifyDryRunInspection(');
  assert.equal(branch.includes('inspectTabUntilStable(tabId)'), true, 'diagnostics must use the stable inspection');
  assert.equal(branch.includes('const inspected = await inspectTab(tabId)'), false, 'diagnostics must not single-shot inspect');
  assert.equal(branch.includes('waitForTabLoad(tabId, 20_000, { urlMatches: X_TAB_URL_PATTERN })'), true);
});

test('the publish flow settles the tab URL and gates the load wait before readiness polling', () => {
  const branch = sliceFrom(engineSource, 'tabId = await getOrCreateAutomationTab(session);', 'await assertOperationActive(item.id, operationId);');
  assert.equal(branch.includes('waitForTabUrlChange(tabId, previousTabUrl)'), true);
  assert.equal(branch.includes('waitForTabLoad(tabId, 20_000, { urlMatches: X_TAB_URL_PATTERN })'), true);
  assert.equal(branch.includes('waitForPublishReady(tabId)'), true, 'readiness polling semantics are unchanged');
});

test('the engine exports the three tab-readiness helpers and the X URL pattern', () => {
  for (const required of ['export const X_TAB_URL_PATTERN', 'export async function waitForTabLoad(', 'export async function waitForTabUrlChange(', 'export async function inspectTabUntilStable(']) {
    assert.equal(engineSource.includes(required), true, `engine must export ${required}`);
  }
  assert.match(engineSource, /performPreflight\([^)]*\) \{[\s\S]*?runPreflight\(\{[\s\S]*?backend: executionBackend \}\);/);
});

test('the preflight card translates raw reason codes for the user', () => {
  assert.equal(operationCardsSource.includes('getUserFacingMessage(check.params.reason)'), true, 'the card must translate the reason param');
  for (const locale of [arSource, enSource]) {
    for (const key of ['adapterReason', 'loginChromeTabHint', 'loginRunnerHint']) {
      assert.equal(locale.includes(key), true, `i18n must define preflight.${key}`);
    }
  }
});

test('preflight domain input carries the execution backend', () => {
  assert.match(preflightDomainSource, /backend\?: 'CHROME_TAB' \| 'LOCAL_RUNNER'/);
});
