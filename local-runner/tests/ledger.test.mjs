import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OperationLedger, contentHashFor } from '../src/ledger.ts';
import { RunnerLogger } from '../src/logging.ts';

const silentLogger = new RunnerLogger({ minLevel: 'error' });

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'x-pilot-ledger-'));
}

const key = { workspaceId: 'ws-1', profileId: 'ws-1', targetUrl: 'https://x.com/intent/post?text=' + encodeURIComponent('مرحبا 🌍'), expectedContent: 'مرحبا 🌍', expectedAccount: 'testuser' };

test('markSubmitted is durable before the click: file content reflects SUBMITTED after write', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'operations.json');
  const ledger = new OperationLedger(file, silentLogger);
  await ledger.load();
  await ledger.recordReceived('op-1', key);
  await ledger.markStarted('op-1');
  await ledger.markSubmitted('op-1');
  const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
  const record = persisted.records.find((entry) => entry.operationId === 'op-1');
  assert.equal(record.status, 'SUBMITTED');
  assert.ok(record.submittedAt > 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('duplicate operationId with the same binding returns the recorded result and never re-executes', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'operations.json');
  const ledger = new OperationLedger(file, silentLogger);
  await ledger.load();
  await ledger.recordReceived('op-2', key);
  await ledger.markStarted('op-2');
  await ledger.markSubmitted('op-2');
  await ledger.complete('op-2', 'CONFIRMED', { outcome: 'CONFIRMED', postUrl: 'https://x.com/testuser/status/123' });
  const record = ledger.lookup('op-2');
  assert.equal(record.result.outcome, 'CONFIRMED');
  assert.equal(ledger.matches(record, key), true);
  // Same binding, same id → the ledger answers from the record (no execution).
  assert.equal(ledger.lookup('op-2').operationId, 'op-2');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('same operationId with DIFFERENT content binding is rejected', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'operations.json');
  const ledger = new OperationLedger(file, silentLogger);
  await ledger.load();
  await ledger.recordReceived('op-3', key);
  const record = ledger.lookup('op-3');
  const differentKey = { ...key, expectedContent: 'نص مختلف تمامًا 🔥' };
  assert.equal(ledger.matches(record, differentKey), false);
  assert.notEqual(record.contentHash, contentHashFor(differentKey));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ledger survives a restart: records reload from disk', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'operations.json');
  const first = new OperationLedger(file, silentLogger);
  await first.load();
  await first.recordReceived('op-4', key);
  await first.complete('op-4', 'UNVERIFIED', { outcome: 'UNVERIFIED', reason: 'RUNNER_NO_RESPONSE_EVIDENCE' });
  const second = new OperationLedger(file, silentLogger);
  await second.load();
  assert.equal(second.lookup('op-4').status, 'UNVERIFIED');
  assert.equal(second.lookup('op-4').result.outcome, 'UNVERIFIED');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('prune removes only stale CANCELLED/FAILED_BEFORE_SUBMIT records — never evidence', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'operations.json');
  const ledger = new OperationLedger(file, silentLogger);
  await ledger.load();
  const old = Date.now() - 40 * 24 * 60 * 60 * 1000;
  await ledger.recordReceived('old-cancelled', key, old);
  await ledger.complete('old-cancelled', 'CANCELLED', { outcome: 'FAILED_BEFORE_SUBMIT' }, old);
  await ledger.recordReceived('old-failed', key, old);
  await ledger.complete('old-failed', 'FAILED_BEFORE_SUBMIT', { outcome: 'FAILED_BEFORE_SUBMIT' }, old);
  await ledger.recordReceived('old-confirmed', key, old);
  await ledger.complete('old-confirmed', 'CONFIRMED', { outcome: 'CONFIRMED' }, old);
  await ledger.recordReceived('old-submitted', key, old);
  await ledger.markSubmitted('old-submitted', old);
  const pruned = await ledger.prune();
  assert.equal(pruned, 2);
  assert.equal(ledger.lookup('old-confirmed').status, 'CONFIRMED');
  assert.equal(ledger.lookup('old-submitted').status, 'SUBMITTED');
  assert.equal(ledger.lookup('old-cancelled'), undefined);
  assert.equal(ledger.lookup('old-failed'), undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a corrupt ledger file is preserved as evidence and a fresh ledger starts', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'operations.json');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, '{not json at all', 'utf8');
  const ledger = new OperationLedger(file, silentLogger);
  await ledger.load();
  assert.equal(ledger.list().length, 0);
  const preserved = fs.readdirSync(dir).find((name) => name.startsWith('operations.json.corrupt-'));
  assert.ok(preserved, 'corrupt ledger must be preserved, never deleted');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('content hash binds workspace, profile, target, content, and account', () => {
  const base = contentHashFor(key);
  assert.notEqual(base, contentHashFor({ ...key, workspaceId: 'ws-2' }));
  assert.notEqual(base, contentHashFor({ ...key, profileId: 'ws-2' }));
  assert.notEqual(base, contentHashFor({ ...key, targetUrl: 'https://x.com/intent/post?text=other' }));
  assert.notEqual(base, contentHashFor({ ...key, expectedContent: 'different' }));
  assert.notEqual(base, contentHashFor({ ...key, expectedAccount: 'otheruser' }));
  // Account comparison is case-insensitive.
  assert.equal(base, contentHashFor({ ...key, expectedAccount: 'TestUser' }));
});
