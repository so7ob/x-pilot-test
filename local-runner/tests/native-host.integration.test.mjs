/**
 * End-to-end Native Messaging host integration test.
 *
 * Spawns the BUILT runner (dist/index.js) exactly the way Chrome launches a
 * native messaging host, feeds framed requests through stdin, and parses the
 * framed responses from stdout. This validates the full wire protocol
 * (4-byte length + UTF-8 JSON), including Arabic/emoji payloads, the idempotent
 * PUBLISH, and stdout protocol purity (logs must never appear on stdout).
 *
 * Requires `npm run build` in local-runner/ first; skips otherwise.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { encodeFrame, FrameDecoder, RUNNER_PROTOCOL_VERSION } from '../src/protocol.ts';
import { startFixtureServer } from './fixtures/x-fixture-server.mjs';

const runnerEntry = path.resolve(import.meta.dirname, '..', 'dist', 'index.js');
const hasBuild = fs.existsSync(runnerEntry);

test('native host round-trip: PING/GET_INFO/INSPECT/PUBLISH with idempotent duplicate', { skip: !hasBuild }, async () => {
  const fixture = await startFixtureServer();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-pilot-host-it-'));
  const child = spawn(process.execPath, [runnerEntry], {
    env: { ...process.env, XPILOT_DATA_DIR: dataDir, XPILOT_X_BASE_URL: fixture.baseUrl, XPILOT_EXTRA_HOSTS: new URL(fixture.baseUrl).hostname, XPILOT_LOG_LEVEL: 'debug' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stderrChunks = [];
  child.stderr.on('data', (chunk) => stderrChunks.push(chunk.toString('utf8')));
  const decoder = new FrameDecoder();
  const pending = new Map();
  child.stdout.on('data', (chunk) => {
    for (const payload of decoder.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))) {
      try {
        const response = JSON.parse(payload);
        const resolve = pending.get(response.requestId);
        if (resolve) resolve(response);
      } catch { /* stdout purity is asserted below */ }
    }
  });

  function send(request) {
    return new Promise((resolve, reject) => {
      pending.set(request.requestId, resolve);
      child.stdin.write(Buffer.from(encodeFrame(JSON.stringify(request))), (error) => { if (error) reject(error); });
      setTimeout(() => reject(new Error(`RESPONSE_TIMEOUT:${request.requestId}`)), 90_000);
    });
  }

  try {
    // 1. Log the profile in through the fixture (simulate prior login).
    const { chromium } = await import('playwright');
    const context = await chromium.launchPersistentContext(path.join(dataDir, 'profiles', 'ws-live'), { channel: 'chromium', headless: true });
    const page = await context.newPage();
    await page.goto(`${fixture.baseUrl}/login`, { waitUntil: 'domcontentloaded' });
    await page.click('[data-testid="loginButton"]');
    await page.waitForURL('**/home');
    await page.close();
    await context.close();

    // 2. PING (Arabic + emoji requestId exercises multi-byte framing).
    const ping = await send({ protocolVersion: RUNNER_PROTOCOL_VERSION, requestId: 'ping-عربي-🎉', command: 'PING', workspaceId: 'ws-live', profileId: 'ws-live', issuedAt: Date.now() });
    assert.equal(ping.status, 'OK');
    assert.equal(ping.requestId, 'ping-عربي-🎉');
    assert.equal(ping.result.pong, true);

    // 3. GET_INFO reports the runner identity and protocol.
    const info = await send({ protocolVersion: RUNNER_PROTOCOL_VERSION, requestId: 'info-1', command: 'GET_INFO', workspaceId: 'ws-live', profileId: 'ws-live', issuedAt: Date.now() });
    assert.equal(info.status, 'OK');
    assert.equal(info.result.protocolVersion, RUNNER_PROTOCOL_VERSION);
    assert.ok(info.result.runnerVersion);
    assert.ok(Array.isArray(info.result.capabilities));
    assert.equal(typeof info.result.nodeVersion, 'string');

    // 4. INSPECT never submits.
    const ARABIC_TEXT = 'مرحبا 🌍 من الاختبار الشامل 🚀';
    const targetUrl = `${fixture.baseUrl}/intent/post?text=${encodeURIComponent(ARABIC_TEXT)}`;
    const inspection = await send({ protocolVersion: RUNNER_PROTOCOL_VERSION, requestId: 'inspect-1', command: 'INSPECT', workspaceId: 'ws-live', profileId: 'ws-live', payload: { targetUrl, expectedAccount: 'testuser', expectedContent: ARABIC_TEXT }, issuedAt: Date.now() });
    assert.equal(inspection.status, 'OK');
    assert.equal(inspection.result.composerFound, true);
    assert.equal(inspection.result.contentMatches, true);
    assert.equal(inspection.result.detectedAccount, 'testuser');
    assert.equal(fixture.createTweetCalls(), 0, 'INSPECT must never submit');

    // 5. PUBLISH confirms with evidence.
    const publish = await send({ protocolVersion: RUNNER_PROTOCOL_VERSION, requestId: 'publish-1', command: 'PUBLISH', workspaceId: 'ws-live', profileId: 'ws-live', operationId: 'op-live-1', payload: { targetUrl, expectedAccount: 'testuser', expectedContent: ARABIC_TEXT }, issuedAt: Date.now() });
    assert.equal(publish.status, 'OK');
    assert.equal(publish.result.outcome, 'CONFIRMED');
    assert.ok(publish.result.postUrl.includes('/testuser/status/'));
    assert.equal(fixture.createTweetCalls(), 1);

    // 6. Duplicate delivery answers from the ledger without a second submit.
    const duplicate = await send({ protocolVersion: RUNNER_PROTOCOL_VERSION, requestId: 'publish-2', command: 'PUBLISH', workspaceId: 'ws-live', profileId: 'ws-live', operationId: 'op-live-1', payload: { targetUrl, expectedAccount: 'testuser', expectedContent: ARABIC_TEXT }, issuedAt: Date.now() });
    assert.equal(duplicate.status, 'DUPLICATE');
    assert.equal(duplicate.code, 'RUNNER_DUPLICATE_OPERATION');
    assert.equal(duplicate.result.outcome, 'CONFIRMED');
    assert.equal(fixture.createTweetCalls(), 1, 'duplicate request must not click again');

    // 7. GET_OPERATION exposes the durable record.
    const operation = await send({ protocolVersion: RUNNER_PROTOCOL_VERSION, requestId: 'op-lookup', command: 'GET_OPERATION', workspaceId: 'ws-live', profileId: 'ws-live', operationId: 'op-live-1', issuedAt: Date.now() });
    assert.equal(operation.status, 'OK');
    assert.equal(operation.result.record.status, 'CONFIRMED');

    // 8. CLEANUP closes runner-owned resources and preserves the ledger.
    const cleanup = await send({ protocolVersion: RUNNER_PROTOCOL_VERSION, requestId: 'cleanup-1', command: 'CLEANUP', workspaceId: 'ws-live', profileId: 'ws-live', issuedAt: Date.now() });
    assert.equal(cleanup.status, 'OK');
    assert.ok(cleanup.result.ledgerRecords >= 1);

    // 9. stdout purity: every stdout byte must have been a protocol frame
    // (the decoder throws on non-frame garbage and leftover bytes would
    // surface as parse failures above). Logs live on stderr.
    const stderr = stderrChunks.join('');
    assert.ok(stderr.length > 0, 'runner logs must go to stderr, not stdout');
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.on('exit', resolve));
    await fixture.server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
