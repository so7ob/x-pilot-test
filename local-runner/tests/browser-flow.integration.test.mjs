/**
 * REAL browser integration tests for the Local Runner.
 *
 * Runs actual Chromium (Playwright) against a local fixture server that
 * emulates the X composer + CreateTweet endpoint. These tests prove:
 * - INSPECT never submits (zero CreateTweet calls).
 * - PUBLISH submits exactly once; a duplicate command never clicks again.
 * - Success is CONFIRMED only with the CreateTweet response evidence.
 * - Rejections, missing responses, and opaque bodies produce REJECTED /
 *   UNVERIFIED — never a fake success.
 * - Login walls stop operations with RUNNER_LOGIN_REQUIRED.
 * - Arabic + emoji content round-trips through the composer verification.
 * - The profile lock prevents concurrent contexts on one profile dir.
 *
 * These are LOCAL automated tests against a fixture. They do NOT prove that
 * publishing works on the live x.com site (stated in the delivery report).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { XFlow } from '../src/x-flow.ts';
import { CommandDispatcher } from '../src/commands.ts';
import { OperationLedger } from '../src/ledger.ts';
import { BrowserManager } from '../src/browser.ts';
import { RUNNER_PROTOCOL_VERSION } from '../src/protocol.ts';
import { RunnerLogger } from '../src/logging.ts';
import { startFixtureServer } from './fixtures/x-fixture-server.mjs';

const silentLogger = new RunnerLogger({ minLevel: 'error' });

const ARABIC_TEXT = 'مرحبا بالعالم 🌍 من X-Pilot 🚀';
const TARGET_URL = (base) => `${base}/intent/post?text=${encodeURIComponent(ARABIC_TEXT)}`;

async function withFixture(fn) {
  const fixture = await startFixtureServer();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-pilot-runner-it-'));
  const previousDataDir = process.env.XPILOT_DATA_DIR;
  process.env.XPILOT_DATA_DIR = dataDir;
  try {
    await fn({ fixture, dataDir });
  } finally {
    if (previousDataDir !== undefined) process.env.XPILOT_DATA_DIR = previousDataDir; else delete process.env.XPILOT_DATA_DIR;
    await fixture.server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

function makeFlow(fixture) {
  return new XFlow(
    { baseUrl: fixture.baseUrl, extraHosts: [new URL(fixture.baseUrl).hostname], timeouts: { navigation: 15_000, composer: 10_000, account: 10_000, evidence: 6_000, click: 5_000 } },
    silentLogger,
  );
}

async function withContext(dataDir, profileId, fn) {
  // channel: 'chromium' = full Chromium in new-headless mode (persists cookies).
  const context = await chromium.launchPersistentContext(path.join(dataDir, 'profiles', profileId), { channel: 'chromium', headless: true, timeout: 60_000 });
  try {
    await fn(context);
  } finally {
    await context.close();
  }
}

test('INSPECT checks readiness and never submits', async () => {
  await withFixture(async ({ fixture, dataDir }) => {
    // Log the profile in first (persist a session cookie).
    await withContext(dataDir, 'ws-1', async (context) => {
      const page = await context.newPage();
      await page.goto(`${fixture.baseUrl}/login`, { waitUntil: 'domcontentloaded' });
      await page.click('[data-testid="loginButton"]');
      await page.waitForURL('**/home');
      const flow = makeFlow(fixture);
      const inspection = await flow.inspectTarget(page, TARGET_URL(fixture.baseUrl), { expectedContent: ARABIC_TEXT, expectedAccount: 'testuser' });
      assert.equal(inspection.pageKind, 'X');
      assert.equal(inspection.composerFound, true);
      assert.equal(inspection.contentPresent, true);
      assert.equal(inspection.contentMatches, true, `Arabic+emoji content must match; got mismatch for ${ARABIC_TEXT}`);
      assert.equal(inspection.postButtonFound, true);
      assert.equal(inspection.postButtonEnabled, true);
      assert.equal(inspection.detectedAccount, 'testuser');
      assert.equal(fixture.createTweetCalls(), 0, 'INSPECT must never submit');
      await page.close();
    });
  });
});

test('PUBLISH confirms once with response evidence; duplicate command never re-executes', async () => {
  await withFixture(async ({ fixture, dataDir }) => {
    const ledger = new OperationLedger(path.join(dataDir, 'ledger', 'operations.json'), silentLogger);
    const browsers = new BrowserManager(silentLogger);
    const flow = makeFlow(fixture);
    const dispatcher = new CommandDispatcher({ ledger, browsers, xFlow: flow, runnerVersion: 'test', logger: silentLogger, emit: () => {} });
    // Login the profile.
    await withContext(dataDir, 'ws-dup', async (context) => {
      const page = await context.newPage();
      await page.goto(`${fixture.baseUrl}/login`, { waitUntil: 'domcontentloaded' });
      await page.click('[data-testid="loginButton"]');
      await page.waitForURL('**/home');
      await page.close();
    });
    const request = { protocolVersion: RUNNER_PROTOCOL_VERSION, requestId: 'req-1', command: 'PUBLISH', workspaceId: 'ws-dup', profileId: 'ws-dup', operationId: 'op-live-1', payload: { targetUrl: TARGET_URL(fixture.baseUrl), expectedAccount: 'testuser', expectedContent: ARABIC_TEXT }, issuedAt: Date.now() };
    const first = await dispatcher.dispatch(request);
    assert.equal(first.status, 'OK');
    assert.equal(first.result.outcome, 'CONFIRMED');
    assert.ok(first.result.postUrl?.includes('/testuser/status/'));
    assert.equal(first.result.evidence?.createTweetResponseStatus, 200);
    assert.equal(fixture.createTweetCalls(), 1);
    const duplicate = await dispatcher.dispatch({ ...request, requestId: 'req-2' });
    assert.equal(duplicate.status, 'DUPLICATE');
    assert.equal(duplicate.code, 'RUNNER_DUPLICATE_OPERATION');
    assert.equal(duplicate.result.outcome, 'CONFIRMED');
    assert.equal(fixture.createTweetCalls(), 1, 'duplicate delivery must never click again');
    await browsers.closeAll();
  });
});

test('A second, DIFFERENT operation for the same item still publishes (distinct operationIds)', async () => {
  await withFixture(async ({ fixture, dataDir }) => {
    const ledger = new OperationLedger(path.join(dataDir, 'ledger', 'operations.json'), silentLogger);
    const browsers = new BrowserManager(silentLogger);
    const flow = makeFlow(fixture);
    const dispatcher = new CommandDispatcher({ ledger, browsers, xFlow: flow, runnerVersion: 'test', logger: silentLogger, emit: () => {} });
    await withContext(dataDir, 'ws-two', async (context) => {
      const page = await context.newPage();
      await page.goto(`${fixture.baseUrl}/login`, { waitUntil: 'domcontentloaded' });
      await page.click('[data-testid="loginButton"]');
      await page.waitForURL('**/home');
      await page.close();
    });
    const first = await dispatcher.dispatch({ protocolVersion: RUNNER_PROTOCOL_VERSION, requestId: 'r1', command: 'PUBLISH', workspaceId: 'ws-two', profileId: 'ws-two', operationId: 'op-a', payload: { targetUrl: TARGET_URL(fixture.baseUrl), expectedAccount: 'testuser', expectedContent: ARABIC_TEXT }, issuedAt: Date.now() });
    assert.equal(first.result.outcome, 'CONFIRMED');
    // A distinct operation id is a distinct publish (the extension only issues
    // a new id after settling the previous one).
    const second = await dispatcher.dispatch({ protocolVersion: RUNNER_PROTOCOL_VERSION, requestId: 'r2', command: 'PUBLISH', workspaceId: 'ws-two', profileId: 'ws-two', operationId: 'op-b', payload: { targetUrl: TARGET_URL(fixture.baseUrl), expectedAccount: 'testuser', expectedContent: ARABIC_TEXT }, issuedAt: Date.now() });
    assert.equal(second.result.outcome, 'CONFIRMED');
    assert.equal(fixture.createTweetCalls(), 2);
    await browsers.closeAll();
  });
});

test('X-side rejection (403 duplicate) becomes REJECTED, never a fake success', async () => {
  await withFixture(async ({ fixture, dataDir }) => {
    fixture.setMode('reject');
    await withContext(dataDir, 'ws-reject', async (context) => {
      const page = await context.newPage();
      await page.goto(`${fixture.baseUrl}/login`, { waitUntil: 'domcontentloaded' });
      await page.click('[data-testid="loginButton"]');
      await page.waitForURL('**/home');
      const flow = makeFlow(fixture);
      const result = await flow.publishTarget(page, TARGET_URL(fixture.baseUrl), { expectedContent: ARABIC_TEXT, expectedAccount: 'testuser' }, async () => {});
      assert.equal(result.outcome, 'REJECTED');
      assert.match(result.reason, /RUNNER_PUBLISH_REJECTED:187:Status is a duplicate/);
      await page.close();
    });
  });
});

test('missing network evidence becomes UNVERIFIED, not a guessed success', async () => {
  await withFixture(async ({ fixture, dataDir }) => {
    fixture.setMode('hang');
    await withContext(dataDir, 'ws-hang', async (context) => {
      const page = await context.newPage();
      await page.goto(`${fixture.baseUrl}/login`, { waitUntil: 'domcontentloaded' });
      await page.click('[data-testid="loginButton"]');
      await page.waitForURL('**/home');
      const flow = makeFlow(fixture);
      const result = await flow.publishTarget(page, TARGET_URL(fixture.baseUrl), { expectedContent: ARABIC_TEXT, expectedAccount: 'testuser' }, async () => {});
      assert.equal(result.outcome, 'UNVERIFIED');
      await page.close();
    });
  });
});

test('a 200 response without a tweet id is UNVERIFIED (opaque body)', async () => {
  await withFixture(async ({ fixture, dataDir }) => {
    fixture.setMode('opaque');
    await withContext(dataDir, 'ws-opaque', async (context) => {
      const page = await context.newPage();
      await page.goto(`${fixture.baseUrl}/login`, { waitUntil: 'domcontentloaded' });
      await page.click('[data-testid="loginButton"]');
      await page.waitForURL('**/home');
      const flow = makeFlow(fixture);
      const result = await flow.publishTarget(page, TARGET_URL(fixture.baseUrl), { expectedContent: ARABIC_TEXT, expectedAccount: 'testuser' }, async () => {});
      assert.equal(result.outcome, 'UNVERIFIED');
      assert.match(result.reason, /RUNNER_RESPONSE_WITHOUT_TWEET_ID/);
      await page.close();
    });
  });
});

test('login wall stops the publish before submit with RUNNER_LOGIN_REQUIRED', async () => {
  await withFixture(async ({ fixture, dataDir }) => {
    await withContext(dataDir, 'ws-loggedout', async (context) => {
      const page = await context.newPage();
      const flow = makeFlow(fixture);
      const result = await flow.publishTarget(page, TARGET_URL(fixture.baseUrl), { expectedContent: ARABIC_TEXT }, async () => { throw new Error('submit must not run'); });
      assert.equal(result.outcome, 'FAILED_BEFORE_SUBMIT');
      assert.equal(result.reason, 'RUNNER_LOGIN_REQUIRED');
      assert.equal(fixture.createTweetCalls(), 0);
      await page.close();
    });
  });
});

test('account mismatch stops the publish before submit', async () => {
  await withFixture(async ({ fixture, dataDir }) => {
    await withContext(dataDir, 'ws-mismatch', async (context) => {
      const page = await context.newPage();
      await page.goto(`${fixture.baseUrl}/login`, { waitUntil: 'domcontentloaded' });
      await page.click('[data-testid="loginButton"]');
      await page.waitForURL('**/home');
      const flow = makeFlow(fixture);
      const result = await flow.publishTarget(page, TARGET_URL(fixture.baseUrl), { expectedContent: ARABIC_TEXT, expectedAccount: 'someoneelse' }, async () => { throw new Error('submit must not run'); });
      assert.equal(result.outcome, 'FAILED_BEFORE_SUBMIT');
      assert.match(result.reason, /RUNNER_ACCOUNT_MISMATCH:testuser/);
      assert.equal(fixture.createTweetCalls(), 0);
      await page.close();
    });
  });
});

test('composer content mismatch refuses to publish (Arabic + emoji binding)', async () => {
  await withFixture(async ({ fixture, dataDir }) => {
    await withContext(dataDir, 'ws-content', async (context) => {
      const page = await context.newPage();
      await page.goto(`${fixture.baseUrl}/login`, { waitUntil: 'domcontentloaded' });
      await page.click('[data-testid="loginButton"]');
      await page.waitForURL('**/home');
      const flow = makeFlow(fixture);
      const result = await flow.publishTarget(page, TARGET_URL(fixture.baseUrl), { expectedContent: 'نص مختلف تمامًا 🔥', expectedAccount: 'testuser' }, async () => { throw new Error('submit must not run'); });
      assert.equal(result.outcome, 'FAILED_BEFORE_SUBMIT');
      assert.equal(result.reason, 'RUNNER_CONTENT_MISMATCH');
      assert.equal(fixture.createTweetCalls(), 0);
      await page.close();
    });
  });
});

test('daily post limit page stops the operation with the explicit limit code', async () => {
  await withFixture(async ({ fixture, dataDir }) => {
    fixture.setMode('daily_limit');
    await withContext(dataDir, 'ws-limit', async (context) => {
      const page = await context.newPage();
      await page.goto(`${fixture.baseUrl}/login`, { waitUntil: 'domcontentloaded' });
      await page.click('[data-testid="loginButton"]');
      await page.waitForURL('**/home');
      const flow = makeFlow(fixture);
      const result = await flow.publishTarget(page, TARGET_URL(fixture.baseUrl), { expectedContent: ARABIC_TEXT }, async () => { throw new Error('submit must not run'); });
      assert.equal(result.outcome, 'FAILED_BEFORE_SUBMIT');
      assert.equal(result.reason, 'RUNNER_DAILY_LIMIT');
      assert.equal(fixture.createTweetCalls(), 0);
      await page.close();
    });
  });
});

test('profile lock blocks a second concurrent context on the same profile dir', async () => {
  await withFixture(async () => {
    const first = new BrowserManager(silentLogger);
    await first.openContext('ws-locked', { headless: true });
    // A SECOND manager simulates a second runner process on the same profile.
    const second = new BrowserManager(silentLogger);
    await assert.rejects(() => second.openContext('ws-locked', { headless: true }), /RUNNER_PROFILE_LOCKED/);
    await first.closeAll();
    await second.closeAll();
    // After close, the profile is usable again.
    const context = await second.openContext('ws-locked', { headless: true });
    await context.close();
  });
});

test('runner-launched contexts never expose navigator.webdriver (issue #12: X and Google refuse automated-looking browsers)', async () => {
  // The v1.5.3 login window exposed navigator.webdriver === true (Playwright
  // default --enable-automation, no AutomationControlled disable, no
  // neutralizer): X's login flow stalled silently after the username step and
  // Google's sign-in refused with "This browser or app may not be secure".
  // This test runs the REAL bundled Chromium through BrowserManager and pins
  // the anti-automation profile end to end.
  await withFixture(async () => {
    const browsers = new BrowserManager(silentLogger);
    try {
      const context = await browsers.openContext('ws-webdriver', { headless: true });
      const page = await context.newPage();
      await page.goto('about:blank');
      const webdriver = await page.evaluate(() => navigator.webdriver);
      assert.notEqual(webdriver, true, 'navigator.webdriver must never be true in a runner-launched context (X login stall + Google "browser not secure")');
      await page.close().catch(() => undefined);
    } finally {
      await browsers.closeAll();
    }
  });
});
