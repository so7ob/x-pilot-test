import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeExecutionBackend, resolveSessionBackend, pinSessionBackend, isExecutionBackend } from '../src/domain/execution.ts';

const active = (status) => ({ status, executionBackend: undefined });
const settings = (executionBackend) => ({ executionBackend });

test('normalizes unknown backend values to CHROME_TAB', () => {
  assert.equal(normalizeExecutionBackend('LOCAL_RUNNER'), 'LOCAL_RUNNER');
  assert.equal(normalizeExecutionBackend('CHROME_TAB'), 'CHROME_TAB');
  assert.equal(normalizeExecutionBackend(undefined), 'CHROME_TAB');
  assert.equal(normalizeExecutionBackend('local-runner'), 'CHROME_TAB');
  assert.equal(normalizeExecutionBackend(null), 'CHROME_TAB');
});

test('active session pins its backend; later settings changes never switch it', () => {
  const session = { status: 'RUNNING', executionBackend: 'LOCAL_RUNNER' };
  assert.equal(resolveSessionBackend(session, settings('CHROME_TAB')), 'LOCAL_RUNNER');
  assert.equal(resolveSessionBackend(session, settings('CHROME_TAB')), 'LOCAL_RUNNER');
  assert.equal(resolveSessionBackend(session, undefined), 'LOCAL_RUNNER');
  // Inactive sessions follow the current settings (applies to the next session).
  assert.equal(resolveSessionBackend(active('STOPPED'), settings('LOCAL_RUNNER')), 'LOCAL_RUNNER');
  assert.equal(resolveSessionBackend(null, settings('LOCAL_RUNNER')), 'LOCAL_RUNNER');
  assert.equal(resolveSessionBackend(undefined, settings('CHROME_TAB')), 'CHROME_TAB');
  // Legacy sessions without a pinned backend use current settings.
  assert.equal(resolveSessionBackend(active('RUNNING'), settings('LOCAL_RUNNER')), 'LOCAL_RUNNER');
});

for (const status of ['RUNNING', 'WAITING', 'PAUSED', 'SCHEDULED']) {
  test(`session in ${status} keeps the pinned backend`, () => {
    assert.equal(resolveSessionBackend({ status, executionBackend: 'CHROME_TAB' }, settings('LOCAL_RUNNER')), 'CHROME_TAB');
  });
}

test('pinSessionBackend writes the backend onto the session record', () => {
  const pinned = pinSessionBackend({ id: 'session-1' }, 'LOCAL_RUNNER');
  assert.equal(pinned.executionBackend, 'LOCAL_RUNNER');
  assert.deepEqual({ ...pinned }, { id: 'session-1', executionBackend: 'LOCAL_RUNNER' });
});

test('isExecutionBackend guards persisted values', () => {
  assert.equal(isExecutionBackend('LOCAL_RUNNER'), true);
  assert.equal(isExecutionBackend('local_runner'), false);
});
