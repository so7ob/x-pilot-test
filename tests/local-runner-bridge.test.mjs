import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Runtime tests for the Service-Worker-side Local Runner bridge using an
 * injectable fake chrome.runtime.connectNative port. Covers request/response
 * correlation, protocol mismatch handling, duplicate (ledger) responses, and
 * the guarantee that a disconnect never re-sends a publish implicitly.
 */

let lastError = undefined;
globalThis.chrome = { runtime: { get lastError() { return lastError; }, connectNative: undefined } };

const { localRunnerBridge } = await import('../src/runner/local-runner-bridge.ts');
const { RUNNER_PROTOCOL_VERSION } = await import('../src/runner/protocol.ts');

function makeFakePort() {
  const listeners = { message: [], disconnect: [] };
  const sent = [];
  const port = {
    name: 'com.so7ob.x_pilot_runner',
    postMessage: (message) => { sent.push(message); queueMicrotask(() => respond(message)); },
    onMessage: { addListener: (listener) => listeners.message.push(listener) },
    onDisconnect: { addListener: (listener) => listeners.disconnect.push(listener) },
    emitMessage: (message) => listeners.message.forEach((listener) => listener(message)),
    emitDisconnect: (message) => { lastError = message ? { message } : undefined; listeners.disconnect.forEach((listener) => listener()); },
    sent,
  };
  function respond(request) {
    if (request.command === 'PING') port.emitMessage({ protocolVersion: RUNNER_PROTOCOL_VERSION, requestId: request.requestId, type: 'RESULT', status: 'OK', code: 'RUNNER_OK', result: { pong: true }, at: Date.now() });
    if (request.command === 'GET_INFO') port.emitMessage({ protocolVersion: 99, requestId: request.requestId, type: 'RESULT', status: 'ERROR', code: 'RUNNER_PROTOCOL_MISMATCH', message: 'extension=1 runner=99', at: Date.now() });
    if (request.command === 'PUBLISH') port.emitMessage({ protocolVersion: RUNNER_PROTOCOL_VERSION, requestId: request.requestId, type: 'RESULT', status: 'DUPLICATE', code: 'RUNNER_DUPLICATE_OPERATION', result: { outcome: 'CONFIRMED', postUrl: 'https://x.com/u/status/1', duplicateOfLedger: true }, at: Date.now() });
    if (request.command === 'GET_OPERATION') port.emitMessage({ protocolVersion: RUNNER_PROTOCOL_VERSION, requestId: request.requestId, type: 'RESULT', status: 'ERROR', code: 'RUNNER_OPERATION_NOT_FOUND', at: Date.now() });
  }
  return port;
}

function freshBridgeWithPort() {
  localRunnerBridge.resetForTest();
  const port = makeFakePort();
  const factory = () => port;
  return { port, factory };
}

test('bridge correlates requests by requestId over the port', async () => {
  const { factory } = freshBridgeWithPort();
  const result = await localRunnerBridge.testConnection('ws-1', 'ws-1', factory);
  // PING answered OK; GET_INFO reports the runner's protocol 99 → mismatch.
  assert.equal(result.ok, false);
  assert.equal(result.code, 'RUNNER_PROTOCOL_MISMATCH');
  const summary = localRunnerBridge.describe();
  assert.equal(summary.state, 'PROTOCOL_MISMATCH');
});

test('duplicate publish responses resolve to the recorded ledger outcome', async () => {
  const { factory } = freshBridgeWithPort();
  const result = await localRunnerBridge.publish({ workspaceId: 'ws-1', profileId: 'ws-1', operationId: 'op-1', targetUrl: 'https://x.com/intent/post?text=x', factory });
  assert.equal(result.outcome, 'CONFIRMED');
  assert.equal(result.duplicateOfLedger, true);
});

test('GET_OPERATION not-found resolves to null (reconciliation stays conservative)', async () => {
  const { factory } = freshBridgeWithPort();
  const record = await localRunnerBridge.getOperation({ workspaceId: 'ws-1', profileId: 'ws-1', operationId: 'op-404', factory });
  assert.equal(record, null);
});

test('a port disconnect rejects in-flight requests with RUNNER_DISCONNECTED and never re-sends', async () => {
  const { port, factory } = freshBridgeWithPort();
  // Make PUBLISH hang so the request is in flight when the port dies.
  const originalRespond = port.postMessage;
  port.postMessage = (message) => { port.sent.push(message); /* no response */ };
  const pending = localRunnerBridge.publish({ workspaceId: 'ws-1', profileId: 'ws-1', operationId: 'op-dis', targetUrl: 'https://x.com/intent/post?text=x', factory });
  await new Promise((resolve) => setTimeout(resolve, 10));
  port.emitDisconnect('Native host has exited.');
  await assert.rejects(() => pending, /RUNNER_DISCONNECTED|Native host has exited/);
  // Exactly ONE publish was written to the port before the disconnect.
  const publishWrites = port.sent.filter((message) => message.command === 'PUBLISH');
  assert.equal(publishWrites.length, 1, 'the bridge must never re-send a publish on its own');
  port.postMessage = originalRespond;
});

test('launch failure maps to the LAUNCH_FAILED runner state', async () => {
  localRunnerBridge.resetForTest();
  const factory = () => { throw new Error('not-installed'); };
  const result = await localRunnerBridge.testConnection('ws-1', 'ws-1', factory);
  assert.equal(result.ok, false);
  assert.equal(localRunnerBridge.describe().state, 'LAUNCH_FAILED');
});
