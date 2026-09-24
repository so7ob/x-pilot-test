import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CommandDispatcher } from '../src/commands.ts';
import { OperationLedger } from '../src/ledger.ts';
import { RUNNER_PROTOCOL_VERSION } from '../src/protocol.ts';
import { RunnerLogger } from '../src/logging.ts';

const silentLogger = new RunnerLogger({ minLevel: 'error' });

function makeHarness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-pilot-commands-'));
  const ledger = new OperationLedger(path.join(dir, 'operations.json'), silentLogger);
  const calls = { publishTarget: 0, inspectTarget: 0, beforeSubmit: 0, openContext: 0 };
  const fakeFlow = {
    baseUrl: 'https://fixture.example',
    async inspectTarget(page, targetUrl, expected) {
      calls.inspectTarget += 1;
      return { pageKind: 'X', composerFound: true, contentPresent: true, contentMatches: true, postButtonFound: true, postButtonEnabled: true, detectedAccount: 'testuser', dailyPostLimitReached: false, checkedAt: Date.now() };
    },
    async publishTarget(page, targetUrl, expected, beforeSubmit) {
      calls.publishTarget += 1;
      await beforeSubmit();
      calls.beforeSubmit += 1;
      return { outcome: 'CONFIRMED', postUrl: 'https://fixture.example/testuser/status/1', detectedAccount: 'testuser', evidence: { createTweetResponseStatus: 200, tweetId: '1' } };
    },
    async detectAccount() { return { pageKind: 'X', account: 'testuser', dailyPostLimitReached: false }; },
  };
  const fakeBrowsers = {
    async openContext(profileId, options) { calls.openContext += 1; return { newPage: async () => ({ close: async () => undefined }), options }; },
    async closeContext() { return undefined; },
    async closeLoginWindow() { return false; },
    isLoginWindowOpen: () => false,
    async closeAll() { return undefined; },
    touch() { return undefined; },
  };
  const events = [];
  const dispatcher = new CommandDispatcher({ ledger, browsers: fakeBrowsers, xFlow: fakeFlow, runnerVersion: '1.5.0-test', logger: silentLogger, emit: (response) => events.push(response) });
  return { dispatcher, ledger, calls, events, dir };
}

const publishRequest = (overrides = {}) => ({
  protocolVersion: RUNNER_PROTOCOL_VERSION,
  requestId: 'req-1',
  command: 'PUBLISH',
  workspaceId: 'ws-1',
  profileId: 'ws-1',
  operationId: 'op-1',
  payload: { targetUrl: 'https://x.com/intent/post?text=' + encodeURIComponent('مرحبا 🌍'), expectedAccount: 'testuser', expectedContent: 'مرحبا 🌍' },
  issuedAt: Date.now(),
  ...overrides,
});

test('PUBLISH executes once; a duplicate delivery returns the recorded result without re-execution', async () => {
  const { dispatcher, calls } = makeHarness();
  const first = await dispatcher.dispatch(publishRequest());
  assert.equal(first.status, 'OK');
  assert.equal(first.result.outcome, 'CONFIRMED');
  assert.equal(calls.publishTarget, 1);
  const duplicate = await dispatcher.dispatch(publishRequest({ requestId: 'req-2' }));
  assert.equal(duplicate.status, 'DUPLICATE');
  assert.equal(duplicate.code, 'RUNNER_DUPLICATE_OPERATION');
  assert.equal(duplicate.result.duplicateOfLedger, true);
  assert.equal(duplicate.result.outcome, 'CONFIRMED');
  assert.equal(duplicate.result.postUrl, 'https://fixture.example/testuser/status/1');
  assert.equal(calls.publishTarget, 1, 'the publish flow must never run twice for one operationId');
  assert.equal(calls.beforeSubmit, 1, 'the submit click hook must fire exactly once');
});

test('same operationId with different content binding is rejected', async () => {
  const { dispatcher, calls } = makeHarness();
  await dispatcher.dispatch(publishRequest());
  const tampered = await dispatcher.dispatch(publishRequest({ requestId: 'req-2', payload: { targetUrl: 'https://x.com/intent/post?text=other', expectedContent: 'other', expectedAccount: 'testuser' } }));
  assert.equal(tampered.status, 'ERROR');
  assert.equal(tampered.code, 'RUNNER_OPERATION_CONTENT_MISMATCH');
  assert.equal(calls.publishTarget, 1);
});

test('CANCEL before submit aborts the operation; after SUBMITTED it never claims cancellation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-pilot-cancel-'));
  const ledger = new OperationLedger(path.join(dir, 'operations.json'), silentLogger);
  let gateBeforeSubmit;
  const gatePromise = new Promise((resolve) => { gateBeforeSubmit = resolve; });
  const fakeFlow = {
    baseUrl: 'https://fixture.example',
    async publishTarget(page, targetUrl, expected, beforeSubmit) {
      await beforeSubmit();
      await gatePromise; // hold the operation in-flight after submit
      return { outcome: 'CONFIRMED', postUrl: 'https://fixture.example/testuser/status/9', detectedAccount: 'testuser' };
    },
    async detectAccount() { return { pageKind: 'X', account: 'testuser', dailyPostLimitReached: false }; },
  };
  const fakeBrowsers = {
    async openContext() { return { newPage: async () => ({ close: async () => undefined }) }; },
    async closeContext() {}, async closeLoginWindow() {}, isLoginWindowOpen: () => false, async closeAll() {}, touch() {},
  };
  const dispatcher = new CommandDispatcher({ ledger, browsers: fakeBrowsers, xFlow: fakeFlow, runnerVersion: 't', logger: silentLogger, emit: () => {} });
  const inFlight = dispatcher.dispatch(publishRequest({ operationId: 'op-cancel' }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  // The ledger now shows SUBMITTED (durable write before the click).
  assert.equal(ledger.lookup('op-cancel').status, 'SUBMITTED');
  const cancelResponse = await dispatcher.dispatch({ protocolVersion: RUNNER_PROTOCOL_VERSION, requestId: 'req-cancel', command: 'CANCEL', workspaceId: 'ws-1', profileId: 'ws-1', operationId: 'op-cancel', issuedAt: Date.now() });
  assert.equal(cancelResponse.result.cancelled, false);
  assert.equal(cancelResponse.result.status, 'SUBMITTED');
  gateBeforeSubmit();
  const outcome = await inFlight;
  assert.equal(outcome.status, 'OK');
  assert.equal(ledger.lookup('op-cancel').status, 'CONFIRMED');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CANCEL of a pre-submit operation marks the ledger CANCELLED and fails the command', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-pilot-cancel2-'));
  const ledger = new OperationLedger(path.join(dir, 'operations.json'), silentLogger);
  let releaseBeforeSubmit;
  const gate = new Promise((resolve) => { releaseBeforeSubmit = resolve; });
  const fakeFlow = {
    baseUrl: 'https://fixture.example',
    async publishTarget(page, targetUrl, expected, beforeSubmit) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (cancelled) throw new Error('RUNNER_CANCELLED');
      await beforeSubmit();
      await gate;
      return { outcome: 'CONFIRMED' };
    },
    async detectAccount() { return { pageKind: 'X', account: 'testuser', dailyPostLimitReached: false }; },
  };
  let cancelled = false;
  const fakeBrowsers = {
    async openContext() { return { newPage: async () => ({ close: async () => undefined }) }; },
    async closeContext() {}, async closeLoginWindow() {}, isLoginWindowOpen: () => false, async closeAll() {}, touch() {},
  };
  const dispatcher = new CommandDispatcher({ ledger, browsers: fakeBrowsers, xFlow: fakeFlow, runnerVersion: 't', logger: silentLogger, emit: () => {} });
  const inFlight = dispatcher.dispatch(publishRequest({ operationId: 'op-cancel-2' }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  cancelled = true;
  const cancelResponse = await dispatcher.dispatch({ protocolVersion: RUNNER_PROTOCOL_VERSION, requestId: 'req-c', command: 'CANCEL', workspaceId: 'ws-1', profileId: 'ws-1', operationId: 'op-cancel-2', issuedAt: Date.now() });
  assert.equal(cancelResponse.result.cancelled, true);
  const outcome = await inFlight;
  assert.equal(outcome.status, 'ERROR');
  assert.equal(outcome.code, 'RUNNER_CANCELLED');
  assert.equal(ledger.lookup('op-cancel-2').status, 'CANCELLED');
  releaseBeforeSubmit();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('INSPECT never invokes the publish flow (command isolation)', async () => {
  const { dispatcher, calls } = makeHarness();
  const response = await dispatcher.dispatch({ protocolVersion: RUNNER_PROTOCOL_VERSION, requestId: 'req-i', command: 'INSPECT', workspaceId: 'ws-1', profileId: 'ws-1', payload: { targetUrl: 'https://x.com/intent/post?text=hi' }, issuedAt: Date.now() });
  assert.equal(response.status, 'OK');
  assert.equal(response.result.composerFound, true);
  assert.equal(calls.inspectTarget, 1);
  assert.equal(calls.publishTarget, 0, 'INSPECT must never reach the publish path');
});

test('protocol mismatch is reported without executing anything', async () => {
  const { dispatcher, calls } = makeHarness();
  const response = await dispatcher.dispatch(publishRequest({ protocolVersion: 99 }));
  assert.equal(response.status, 'ERROR');
  assert.equal(response.code, 'RUNNER_PROTOCOL_MISMATCH');
  assert.equal(calls.publishTarget, 0);
});

test('unknown commands are rejected by the allowlist', async () => {
  const { dispatcher } = makeHarness();
  const response = await dispatcher.dispatch({ protocolVersion: RUNNER_PROTOCOL_VERSION, requestId: 'req-x', command: 'EVAL_JS', workspaceId: 'ws-1', profileId: 'ws-1', issuedAt: Date.now() });
  assert.equal(response.status, 'ERROR');
  assert.equal(response.code, 'RUNNER_UNKNOWN_COMMAND');
});

test('GET_OPERATION returns the durable record and NOT_FOUND for unknown ids', async () => {
  const { dispatcher } = makeHarness();
  await dispatcher.dispatch(publishRequest({ operationId: 'op-known' }));
  const found = await dispatcher.dispatch({ protocolVersion: RUNNER_PROTOCOL_VERSION, requestId: 'req-g', command: 'GET_OPERATION', workspaceId: 'ws-1', profileId: 'ws-1', operationId: 'op-known', issuedAt: Date.now() });
  assert.equal(found.status, 'OK');
  assert.equal(found.result.record.status, 'CONFIRMED');
  const missing = await dispatcher.dispatch({ protocolVersion: RUNNER_PROTOCOL_VERSION, requestId: 'req-g2', command: 'GET_OPERATION', workspaceId: 'ws-1', profileId: 'ws-1', operationId: 'op-missing', issuedAt: Date.now() });
  assert.equal(missing.status, 'ERROR');
  assert.equal(missing.code, 'RUNNER_OPERATION_NOT_FOUND');
});

test('a runner crash between SUBMITTED and completion leaves a reconcilable record', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-pilot-crash-'));
  const ledger = new OperationLedger(path.join(dir, 'operations.json'), silentLogger);
  // Simulate: received → started → submitted, then the process died.
  await ledger.load();
  await ledger.recordReceived('op-crash', { workspaceId: 'ws-1', profileId: 'ws-1', targetUrl: 'https://x.com/intent/post?text=x', expectedContent: 'x' });
  await ledger.markStarted('op-crash');
  await ledger.markSubmitted('op-crash');
  const reloaded = new OperationLedger(path.join(dir, 'operations.json'), silentLogger);
  await reloaded.load();
  assert.equal(reloaded.lookup('op-crash').status, 'SUBMITTED', 'the extension must see SUBMITTED and treat it as PUBLISHED_UNVERIFIED');
  fs.rmSync(dir, { recursive: true, force: true });
});
