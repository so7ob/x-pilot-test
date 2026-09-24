import type { AutomationSession, ExecutionBackend, Settings } from './models';

/**
 * Execution backend layer (pure domain).
 *
 * X-Pilot can drive the X publishing flow through one of two engines:
 * - CHROME_TAB: the original in-browser automation tab + content script flow.
 * - LOCAL_RUNNER: the X-Pilot Local Runner native host driving a separate
 *   headless Chromium via Playwright (no X tab is ever opened in the user's
 *   daily Chrome).
 *
 * Invariants enforced here (guarded by tests):
 * - The backend is PINNED per session. Changing the setting while a session is
 *   active never switches the engine of the running operation.
 * - There is no implicit fallback from LOCAL_RUNNER to CHROME_TAB. Losing the
 *   runner fails the operation with an explicit reason; switching engines is a
 *   user decision made after the current operation state is settled.
 */

const knownBackends: readonly ExecutionBackend[] = ['CHROME_TAB', 'LOCAL_RUNNER'];

export function normalizeExecutionBackend(value: unknown): ExecutionBackend {
  return knownBackends.includes(value as ExecutionBackend) ? (value as ExecutionBackend) : 'CHROME_TAB';
}

export function isExecutionBackend(value: unknown): value is ExecutionBackend {
  return knownBackends.includes(value as ExecutionBackend);
}

/**
 * Resolves the effective backend for the currently executing session.
 * A session pins its backend at creation; while the session is active the
 * pinned value wins over any later settings change.
 */
export function resolveSessionBackend(session: Pick<AutomationSession, 'status' | 'executionBackend'> | null | undefined, settings: Pick<Settings, 'executionBackend'> | undefined): ExecutionBackend {
  const activeSession = session && ['RUNNING', 'WAITING', 'PAUSED', 'SCHEDULED'].includes(session.status);
  if (activeSession && session?.executionBackend) return session.executionBackend;
  return normalizeExecutionBackend(settings?.executionBackend);
}

/** Pins the backend on a session record at creation time. */
export function pinSessionBackend<T extends { executionBackend?: ExecutionBackend }>(session: T, backend: ExecutionBackend): T & { executionBackend: ExecutionBackend } {
  return { ...session, executionBackend: backend };
}

export function isRunnerBackend(backend: ExecutionBackend): boolean {
  return backend === 'LOCAL_RUNNER';
}
