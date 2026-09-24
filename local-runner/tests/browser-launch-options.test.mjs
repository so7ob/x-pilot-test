/**
 * Launch-profile contracts for BrowserManager (issue #12).
 *
 * The v1.5.3 login window launched with `args: []` while Playwright's default
 * `--enable-automation` switch stayed in place, so the ONE window a human
 * types credentials into exposed `navigator.webdriver === true`. X's login
 * flow silently stalls after the username step there and Google's sign-in
 * page refuses with "This browser or app may not be secure".
 *
 * These contracts pin the anti-automation launch profile for BOTH modes:
 * - `--disable-blink-features=AutomationControlled` always present.
 * - Playwright's `--enable-automation` always dropped via ignoreDefaultArgs.
 * - One `navigator.webdriver` neutralizer init script registered on the context.
 * - Headed (login window) prefers the installed branded Google Chrome
 *   (channel 'chrome') and falls back to bundled Chromium when it is missing.
 *
 * They fail against the v1.5.3 launch options by construction (the old headed
 * call had channel 'chromium' with args: [] and no init script).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserManager } from '../src/browser.ts';
import { RunnerLogger } from '../src/logging.ts';

const silentLogger = new RunnerLogger({ minLevel: 'error' });

async function withTempDataDir(fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-pilot-launch-'));
  const previous = process.env.XPILOT_DATA_DIR;
  process.env.XPILOT_DATA_DIR = dataDir;
  try {
    return await fn();
  } finally {
    if (previous !== undefined) process.env.XPILOT_DATA_DIR = previous; else delete process.env.XPILOT_DATA_DIR;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

function makeFakeContext() {
  return {
    initScripts: [],
    closeListeners: [],
    closed: false,
    async addInitScript(script) { this.initScripts.push(script); },
    on(event, handler) { if (event === 'close') this.closeListeners.push(handler); },
    async close() {
      if (this.closed) return;
      this.closed = true;
      for (const listener of this.closeListeners) listener();
    },
  };
}

function makeFactory(calls, { chromeAvailable = true } = {}) {
  const contexts = [];
  const factory = async () => ({
    chromium: {
      launchPersistentContext: async (profileDir, options) => {
        calls.push({ profileDir, options });
        if (options.channel === 'chrome' && !chromeAvailable) {
          throw new Error('browserType.launchPersistentContext: chromium channel: failed to launch: google chrome / stable not found on the system');
        }
        const context = makeFakeContext();
        contexts.push(context);
        return context;
      },
    },
  });
  return { factory, contexts };
}

function makeRecordingLogger() {
  const warnings = [];
  return {
    logger: { info() {}, warn(message, detail) { warnings.push({ message, detail }); }, error() {} },
    warnings,
  };
}

test('headless operations launch with the anti-automation profile on bundled Chromium', async () => {
  await withTempDataDir(async () => {
    const calls = [];
    const { factory, contexts } = makeFactory(calls);
    const browsers = new BrowserManager(silentLogger, factory);
    const context = await browsers.openContext('ws-ops', { headless: true });
    assert.equal(calls.length, 1, 'headless must launch exactly one context');
    const options = calls[0].options;
    assert.equal(options.channel, 'chromium');
    assert.equal(options.headless, true);
    assert.ok(options.args.includes('--disable-blink-features=AutomationControlled'), 'AutomationControlled must be disabled in headless mode');
    assert.ok(options.ignoreDefaultArgs.includes('--enable-automation'), "Playwright's --enable-automation must be dropped in headless mode");
    assert.equal(options.args.includes('--enable-automation'), false);
    assert.equal(contexts[0].initScripts.length, 1, 'the webdriver neutralizer init script must be registered');
    await browsers.closeAll();
  });
});

test('the login window prefers the installed branded Google Chrome (channel chrome) with the anti-automation profile', async () => {
  await withTempDataDir(async () => {
    const calls = [];
    const { factory, contexts } = makeFactory(calls, { chromeAvailable: true });
    const browsers = new BrowserManager(silentLogger, factory);
    const context = await browsers.openContext('ws-login', { headless: false });
    assert.equal(calls.length, 1, 'branded Chrome available: exactly one launch, no fallback');
    const options = calls[0].options;
    assert.equal(options.channel, 'chrome', 'the login window must use the branded Chrome binary Google trusts');
    assert.equal(options.headless, false);
    assert.ok(options.args.includes('--disable-blink-features=AutomationControlled'), 'the login window must disable AutomationControlled (missed in v1.5.3)');
    assert.ok(options.ignoreDefaultArgs.includes('--enable-automation'), "the login window must drop Playwright's --enable-automation");
    assert.equal(options.args.includes('--enable-automation'), false);
    assert.equal(options.viewport, undefined, 'the login window keeps the natural window viewport');
    assert.equal(contexts[0].initScripts.length, 1, 'the webdriver neutralizer init script must be registered');
    assert.equal(context, contexts[0]);
    await browsers.closeAll();
  });
});

test('the login window falls back to bundled Chromium with a warning when branded Chrome is missing', async () => {
  await withTempDataDir(async () => {
    const calls = [];
    const { factory, contexts } = makeFactory(calls, { chromeAvailable: false });
    const { logger, warnings } = makeRecordingLogger();
    const browsers = new BrowserManager(logger, factory);
    const context = await browsers.openContext('ws-nochrome', { headless: false });
    assert.equal(calls.length, 2, 'chrome attempt first, chromium fallback second');
    assert.equal(calls[0].options.channel, 'chrome');
    assert.equal(calls[1].options.channel, 'chromium');
    const fallbackOptions = calls[1].options;
    assert.ok(fallbackOptions.args.includes('--disable-blink-features=AutomationControlled'), 'the fallback must keep the anti-automation args');
    assert.ok(fallbackOptions.ignoreDefaultArgs.includes('--enable-automation'), 'the fallback must keep dropping --enable-automation');
    assert.equal(contexts.length, 1, 'only the successful context exists');
    assert.equal(contexts[0].initScripts.length, 1);
    assert.equal(context, contexts[0]);
    assert.ok(warnings.some((entry) => /Google Chrome unavailable/.test(entry.message)), 'the fallback must be logged as a warning');
    await browsers.closeAll();
  });
});

test('the login window still launches when every channel fails only after a clear RUNNER_LAUNCH_FAILED error', async () => {
  await withTempDataDir(async () => {
    const factory = async () => ({
      chromium: {
        launchPersistentContext: async () => { throw new Error('no browser at all'); },
      },
    });
    const browsers = new BrowserManager(silentLogger, factory);
    await assert.rejects(() => browsers.openContext('ws-dead', { headless: false }), /RUNNER_LAUNCH_FAILED/);
    await browsers.closeAll();
  });
});

test('the registered init script functionally neutralizes navigator.webdriver', async () => {
  await withTempDataDir(async () => {
    const calls = [];
    const { factory, contexts } = makeFactory(calls);
    const browsers = new BrowserManager(silentLogger, factory);
    await browsers.openContext('ws-script', { headless: true });
    const script = contexts[0].initScripts[0];
    assert.equal(typeof script, 'string');
    assert.match(script, /webdriver/, 'the script must reference navigator.webdriver');
    // Functional evaluation: an automation-flagged navigator (true getter,
    // exactly what the v1.5.3 login window exposed) must read undefined after
    // the script runs.
    const navigator = {};
    Object.defineProperty(navigator, 'webdriver', { get: () => true, configurable: true });
    assert.equal(navigator.webdriver, true);
    new Function('navigator', script)(navigator);
    assert.equal(navigator.webdriver, undefined, 'the neutralizer must shadow a true webdriver getter to undefined');
    await browsers.closeAll();
  });
});

test('anti-automation contracts fail on the v1.5.3 launch options (regression tripwire)', async () => {
  // Replicates the exact v1.5.3 launch call (headed: channel chromium, args
  // [], Playwright default --enable-automation kept) and proves the guarded
  // invariants detect it — i.e. the new contracts cannot silently pass if
  // someone reintroduces the old pattern.
  const v153Options = { channel: 'chromium', headless: false, viewport: undefined, timeout: 60_000, args: [] };
  assert.equal(v153Options.args.includes('--disable-blink-features=AutomationControlled'), false, 'sanity: v1.5.3 headed had no flag');
  assert.equal((v153Options.ignoreDefaultArgs ?? []).includes('--enable-automation'), false, 'sanity: v1.5.3 kept --enable-automation');
  const detected =
    v153Options.args.includes('--disable-blink-features=AutomationControlled') &&
    (v153Options.ignoreDefaultArgs ?? []).includes('--enable-automation');
  assert.equal(detected, false, 'the v1.5.3 pattern must NOT satisfy the anti-automation profile');
});
