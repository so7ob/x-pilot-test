import test from 'node:test';
import assert from 'node:assert/strict';
import { decideRunnerReconciliation } from '../src/domain/runner-reconciliation.ts';

const record = (status, extra = {}) => ({ operationId: 'op-1', status, createdAt: 1, updatedAt: 2, workspaceId: 'ws-1', profileId: 'ws-1', targetUrl: 'https://x.com/intent/post?text=x', contentHash: 'hash', ...extra });

test('CONFIRMED ledger proof publishes the item with the recorded URL evidence', () => {
  const decision = decideRunnerReconciliation(record('CONFIRMED', { completedAt: 123, result: { outcome: 'CONFIRMED', postUrl: 'https://x.com/user/status/9' } }));
  assert.deepEqual(decision, { action: 'PUBLISHED', publishedAt: 123, postUrl: 'https://x.com/user/status/9' });
});

test('SUBMITTED (crash between durable write and completion) is CONSERVATIVE — never PENDING', () => {
  const decision = decideRunnerReconciliation(record('SUBMITTED', { submittedAt: 5 }));
  assert.equal(decision.action, 'CONSERVATIVE');
});

test('UNVERIFIED outcome is CONSERVATIVE — never automatically republished', () => {
  const decision = decideRunnerReconciliation(record('UNVERIFIED'));
  assert.equal(decision.action, 'CONSERVATIVE');
});

test('pre-submit statuses prove the click never happened and requeue safely', () => {
  for (const status of ['RECEIVED', 'STARTED', 'CANCELLED', 'FAILED_BEFORE_SUBMIT']) {
    const decision = decideRunnerReconciliation(record(status));
    assert.equal(decision.action, 'PENDING', status);
    assert.match(decision.reason, new RegExp(`RUNNER_INTERRUPTED_PRE_SUBMIT:${status}`));
  }
});

test('REJECTED ledger proof fails the item with the recorded reason', () => {
  const decision = decideRunnerReconciliation(record('REJECTED', { result: { outcome: 'REJECTED', reason: 'RUNNER_PUBLISH_REJECTED:187:duplicate' } }));
  assert.deepEqual(decision, { action: 'FAILED', reason: 'RUNNER_PUBLISH_REJECTED:187:duplicate' });
});

test('unknown ledger statuses fall to the conservative default', () => {
  const decision = decideRunnerReconciliation(record('SOMETHING_NEW'));
  assert.equal(decision.action, 'CONSERVATIVE');
  assert.equal(decision.status, 'SOMETHING_NEW');
});

test('a disconnected channel (no record) never reaches this mapper — domain recovery owns it', async () => {
  // Importing recovery proves the conservative fallback still quarantines
  // interrupted PUBLISHING items as PUBLISHED_UNVERIFIED.
  const { normalizeRecovery } = await import('../src/domain/recovery.ts');
  const state = { queue: [{ id: 'i1', status: 'PUBLISHING', operationId: 'op-x', publishIntentId: 'op-x', publishStartedAt: 1, targetUrl: 'u', sourceBankUrl: 'b', position: 1, attempts: 1, createdAt: 1, updatedAt: 1 }], session: { id: 's1', status: 'RUNNING', currentItemId: 'i1', currentIndex: 1, total: 1, bankUrl: 'b', intervalMinutes: 1, maxRetries: 1, failureBehavior: 'PAUSE', confirmBeforeStart: false, keepAutomationTabOpen: true, closeTabOnComplete: false, version: 1, updatedAt: 1 }, history: [] };
  const recovered = normalizeRecovery(state, 100);
  assert.equal(recovered.queue[0].status, 'PUBLISHED_UNVERIFIED');
  assert.equal(recovered.session.status, 'PAUSED');
});
