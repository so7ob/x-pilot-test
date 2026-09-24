import type { AppState, AutomationSession, ContentInspection, RuntimeStatus } from '../domain/models';
import type { RunnerInspection, RunnerOperationRecord } from '../runner/protocol';
import { createHistoricalSession } from '../domain/models';
import { buildStartOverQueue, countStartOverResets, hasFutureRecoveryAlarm, normalizeRecovery } from '../domain/recovery';
import { canStartItem, getNextPendingItem, getNextRunnableItem } from '../domain/state-machine';
import { runPreflight } from '../domain/preflight';
import { getNextAllowedPublishingTime } from '../domain/scheduling';
import { decideAlarmFailure } from '../domain/alarm-recovery';
import { shouldNeverRepublish } from '../domain/data-integrity.ts';
import { normalizeExecutionBackend, resolveSessionBackend } from '../domain/execution.ts';
import { decideRunnerReconciliation } from '../domain/runner-reconciliation.ts';
import { publishContentFromIntentUrl } from '../domain/intent-url.ts';
import { localRunnerBridge } from '../runner/local-runner-bridge.ts';
import { getStoredLocale, formatDateTimeForLocale, translateForLocale } from '../i18n/translate.ts';
import { acquireStartLock, claimAutomationOwner, getAutomationOwner, getMeta, getSettings, getState as getActiveState, getWorkspaceSettings, getWorkspaceState, listWorkspaces, releaseAutomationOwner, releaseStartLock, renewStartLock, saveHistoricalSession, updateHistoricalSession, updateState as updateActiveState, updateWorkspaceState } from '../storage/storage-repository';

/**
 * X-Pilot automation engine.
 *
 * Owns the ONLY code that can publish: the run loop (processCurrentItem /
 * advanceSession), engine state helpers, automation-tab lifecycle, scheduling,
 * alarms, and recovery. The service worker routes messages to the exported
 * control operations; it must never re-implement engine behavior here.
 *
 * Safety invariants enforced in this module (guarded by contracts):
 * - shouldNeverRepublish + canStartItem gate every publish attempt
 * - publish intent (publishIntentId) is persisted before the submit call
 * - uncertain outcomes become PUBLISHED_UNVERIFIED + PAUSED and never re-publish
 * - tab cleanup happens in finally; injection state is tracked per tab
 * - START holds a renewal lease (acquire/renew/release) and preflight gate
 * - the execution backend (CHROME_TAB | LOCAL_RUNNER) is pinned per session and
 *   never falls back implicitly; LOCAL_RUNNER opens NO X tab in the user's
 *   Chrome (guarded by the runner-mode no-tabs contract tests)
 */

export const ALARM_NAME = 'x-queue-next-item';
export const SCHEDULE_ALARM_NAME = 'x-queue-scheduled-start';
const AUTOMATION_TAB_KEY = 'automationTabId';
export const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const injectedContentTabs = new Set<number>();
const contentInjectionInFlight = new Map<number, Promise<void>>();

export async function getState(): Promise<AppState> {
  const owner = await getAutomationOwner();
  return owner ? getWorkspaceState(owner) : getActiveState();
}

export async function updateRuntimeState(mutator: (state: AppState) => AppState): Promise<AppState> {
  const owner = await getAutomationOwner();
  if (!owner) return updateActiveState(mutator);
  const saved = await updateWorkspaceState(owner, (state) => ({ ...state, ...mutator(state), workspaceId: owner }));
  return { workspaceId: saved.workspaceId, queue: saved.queue, session: saved.session, history: saved.history };
}

export async function commitQueueMutation(mutator: (state: AppState) => AppState): Promise<AppState> {
  const next = await updateRuntimeState(mutator);
  await broadcast(next);
  return next;
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') injectedContentTabs.delete(tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  injectedContentTabs.delete(tabId);
  contentInjectionInFlight.delete(tabId);
  void getState().then((state) => {
    if (state.session?.automationTabId !== tabId) return;
    void chrome.storage.local.remove(AUTOMATION_TAB_KEY);
    void updateRuntimeState((current) => current.session?.automationTabId === tabId
      ? { ...current, session: { ...current.session, automationTabId: undefined, updatedAt: Date.now() } }
      : current);
  }).catch(() => undefined);
});

export async function broadcast(state?: AppState) {
  const snapshot = state ?? await getState();
  await chrome.runtime.sendMessage({ type: 'STATE_UPDATED', state: snapshot }).catch(() => undefined);
  await updateBadge(snapshot);
}

export async function getRuntimeStatus(): Promise<RuntimeStatus> {
  const automationWorkspaceId = await getAutomationOwner();
  const state = await getState();
  const session = state.session;
  const settings = await getSettings();
  const runnerSummary = localRunnerBridge.describe();
  const base: RuntimeStatus = {
    engineStatus: session?.status ?? 'IDLE',
    connection: 'NOT_REQUIRED',
    automationWorkspaceId,
    checkedAt: Date.now(),
    executionBackend: normalizeExecutionBackend(settings.executionBackend),
    sessionExecutionBackend: session?.executionBackend,
    runner: runnerSummary,
  };
  const activeEngine = session?.status === 'RUNNING' || session?.status === 'WAITING' || session?.status === 'PAUSED';
  const pinnedRunnerSession = resolveSessionBackend(session, settings) === 'LOCAL_RUNNER';
  if (pinnedRunnerSession) {
    if (!activeEngine) return base;
    return { ...base, connection: runnerSummary.connected ? 'CONNECTED' : 'DISCONNECTED' };
  }
  if (!activeEngine || !session?.automationTabId) {
    return base;
  }
  try {
    await chrome.tabs.get(session.automationTabId);
    return { ...base, connection: 'CONNECTED', automationTabId: session.automationTabId, automationWorkspaceId };
  } catch {
    return { ...base, connection: 'DISCONNECTED', automationTabId: session.automationTabId, automationWorkspaceId };
  }
}

export async function notifyEvent(title: string, message: string): Promise<void> {
  const settings = await getSettings();
  if (!settings.notificationsEnabled || !chrome.notifications) return;
  const locale = await getStoredLocale();
  const titleKeys: Record<string, string> = {
    'X-Pilot: اكتملت الجلسة': 'notifications.sessionCompletedTitle',
    'X-Pilot: مطلوب تدخل': 'notifications.interventionTitle',
    'X-Pilot: فشل عنصر': 'notifications.failedItemTitle',
    'X-Pilot: جلسة مجدولة': 'notifications.scheduledTitle',
    'X-Pilot: بدأت الجلسة': 'notifications.startedTitle',
    'X-Pilot: تحدٍ أمني': 'notifications.challenge',
    'X-Pilot: خارج نافذة النشر': 'notifications.outsideWindow',
    'X-Pilot: فشل فحص الجاهزية': 'notifications.preflightFailed',
    'X-Pilot: توقفت Queue مؤقتًا': 'notifications.paused',
  };
  const messageKeys: Record<string, string> = {
    'اكتملت جميع عناصر Queue.': 'notifications.sessionCompletedMessage',
    'تسجيل الدخول إلى X مطلوب.': 'notifications.loginRequired',
    'تم اكتشاف CAPTCHA أو Challenge وتوقفت الجلسة.': 'notifications.challenge',
  };
  const translatedTitle = titleKeys[title] ? translateForLocale(locale, titleKeys[title]) : title;
  let translatedMessage = messageKeys[message] ? translateForLocale(locale, messageKeys[message]) : message;
  translatedMessage = translatedMessage.replace(/سيستأنف النشر في (.+)$/u, (_, value) => `${translateForLocale(locale, 'notifications.outsideWindow')}: ${formatDateTimeForLocale(value, locale)}`);
  await chrome.notifications.create(`x-pilot-${Date.now()}`, { type: 'basic', iconUrl: 'icons/icon128.png', title: translatedTitle, message: translatedMessage });
}

export async function updateBadge(state?: AppState): Promise<void> {
  const settings = await getSettings();
  const snapshot = state ?? await getState();
  let text = '';
  if (settings.badgeMode === 'COUNT') text = String(snapshot.queue.filter((item) => item.status === 'PENDING' || item.status === 'FAILED').length || '');
  if (settings.badgeMode === 'STATUS') text = snapshot.session?.status === 'RUNNING' ? '▶' : snapshot.session?.status === 'PAUSED' ? 'Ⅱ' : snapshot.session?.status === 'FAILED' ? '!' : '';
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: snapshot.session?.status === 'FAILED' ? '#b42318' : '#175fbe' });
}

/**
 * Runner-ledger reconciliation for interrupted LOCAL_RUNNER operations.
 *
 * Runs BEFORE the conservative domain recovery. For every item left in
 * PUBLISHING with a persisted operationId, the durable runner ledger is
 * queried (GET_OPERATION). Only ledger-proven states may relax the
 * conservative defaults:
 * - CONFIRMED → PUBLISHED (with the recorded post URL as evidence).
 * - RECEIVED / STARTED / CANCELLED / FAILED_BEFORE_SUBMIT → PENDING (the
 *   ledger proves the submit click never happened).
 * - REJECTED → FAILED (X-side refusal recorded).
 * - SUBMITTED / UNVERIFIED (or an unreachable runner) → left untouched so the
 *   domain recovery keeps the conservative PUBLISHED_UNVERIFIED path. A
 *   disconnected channel is NEVER interpreted as proof of publish failure.
 */
export async function reconcileInterruptedRunnerOperations(state: AppState): Promise<AppState> {
  const session = state.session;
  if (!session?.workspaceId) return state;
  const settings = await getSettings();
  const backend = resolveSessionBackend(session, settings);
  if (backend !== 'LOCAL_RUNNER') return state;
  const interrupted = state.queue.filter((item) => item.status === 'PUBLISHING' && item.operationId);
  if (!interrupted.length) return state;
  const historyAdditions: import('../domain/models').LegacyPublishAttempt[] = [];
  let nextQueue = state.queue;
  for (const item of interrupted) {
    let record: RunnerOperationRecord | null = null;
    try {
      record = await localRunnerBridge.getOperation({ workspaceId: session.workspaceId!, profileId: session.workspaceId!, operationId: item.operationId! });
    } catch {
      // Runner unreachable or ledger query failed: keep the conservative
      // PUBLISHING state; normalizeRecovery will quarantine it safely.
      continue;
    }
    if (!record) continue;
    const now = Date.now();
    const decision = decideRunnerReconciliation(record);
    if (decision.action === 'PUBLISHED') {
      nextQueue = nextQueue.map((candidate) => candidate.id === item.id ? { ...candidate, status: 'PUBLISHED', publishedAt: decision.publishedAt, lastError: undefined, operationId: undefined, publishIntentId: undefined, publishStartedAt: undefined, publishSubmittedAt: undefined, updatedAt: now } : candidate);
      historyAdditions.push({ id: crypto.randomUUID(), workspaceId: state.workspaceId, sessionId: session.id, queueItemId: item.id, link: item.targetUrl, sourceUrl: item.targetUrl, publishedPostUrl: decision.postUrl, timestamp: now, attemptNumber: item.attempts, action: 'PUBLISH', result: 'PUBLISHED' });
    } else if (decision.action === 'FAILED') {
      nextQueue = nextQueue.map((candidate) => candidate.id === item.id ? { ...candidate, status: 'FAILED', lastError: decision.reason, operationId: undefined, publishIntentId: undefined, publishStartedAt: undefined, publishSubmittedAt: undefined, updatedAt: now } : candidate);
      historyAdditions.push({ id: crypto.randomUUID(), workspaceId: state.workspaceId, sessionId: session.id, queueItemId: item.id, link: item.targetUrl, sourceUrl: item.targetUrl, timestamp: now, attemptNumber: item.attempts, action: 'PUBLISH', result: 'FAILED', error: decision.reason });
    } else if (decision.action === 'PENDING') {
      // Ledger proves the irreversible submit step was never reached.
      nextQueue = nextQueue.map((candidate) => candidate.id === item.id ? { ...candidate, status: 'PENDING', lastError: decision.reason, operationId: undefined, publishIntentId: undefined, publishStartedAt: undefined, publishSubmittedAt: undefined, updatedAt: now } : candidate);
      historyAdditions.push({ id: crypto.randomUUID(), workspaceId: state.workspaceId, sessionId: session.id, queueItemId: item.id, link: item.targetUrl, sourceUrl: item.targetUrl, timestamp: now, attemptNumber: item.attempts, action: 'INSPECT', result: 'PENDING', error: decision.reason });
    }
    // CONSERVATIVE falls through: domain recovery quarantines the item as
    // PUBLISHED_UNVERIFIED (never automatically republished).
  }
  if (nextQueue === state.queue && !historyAdditions.length) return state;
  return { ...state, queue: nextQueue, history: [...state.history, ...historyAdditions] };
}

export async function recoverPersistedState(): Promise<AppState> {
  const current = await getState();
  const reconciled = await reconcileInterruptedRunnerOperations(current);
  const recovered = normalizeRecovery(reconciled);
  const changed = JSON.stringify(recovered) !== JSON.stringify(current);
  const state = changed ? await updateRuntimeState(() => recovered) : current;
  await chrome.alarms.clear(ALARM_NAME);
  await chrome.alarms.clear(SCHEDULE_ALARM_NAME);
  if (state.session?.status === 'SCHEDULED' && state.session.scheduledStartAt && state.session.scheduledStartAt > Date.now()) await chrome.alarms.create(SCHEDULE_ALARM_NAME, { when: state.session.scheduledStartAt, persistAcrossSessions: true });
  if (hasFutureRecoveryAlarm(state)) await chrome.alarms.create(ALARM_NAME, { when: state.session!.nextRunAt!, persistAcrossSessions: true });
  await updateBadge(state);
  await broadcast(state);
  return state;
}

export async function syncHistoricalSession(state: AppState, status?: 'RUNNING' | 'PAUSED' | 'WAITING' | 'COMPLETED' | 'STOPPED' | 'FAILED', failureReason?: string): Promise<void> {
  const session = state.session;
  if (!state.workspaceId || !session?.historicalSessionId) return;
  await updateHistoricalSession(state.workspaceId, session.historicalSessionId, {
    ...(status ? { status } : {}),
    ...(status === 'COMPLETED' || status === 'STOPPED' || status === 'FAILED' ? { completedAt: Date.now() } : {}),
    ...(failureReason ? { failureReason } : {}),
    totalItems: state.queue.length,
    publishedCount: state.queue.filter((item) => item.status === 'PUBLISHED' || item.status === 'PUBLISHED_UNVERIFIED').length,
    failedCount: state.queue.filter((item) => item.status === 'FAILED').length,
    skippedCount: state.queue.filter((item) => item.status === 'SKIPPED').length,
  });
}

export async function getOrCreateAutomationTab(session: AutomationSession): Promise<number> {
  if (session.automationTabId) {
    try {
      await chrome.tabs.get(session.automationTabId);
      return session.automationTabId;
    } catch { /* recreate below */ }
  }
  const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
  if (!tab.id) throw new Error('AUTOMATION_TAB_CREATE_FAILED');
  await updateRuntimeState((state) => ({ ...state, session: state.session ? { ...state.session, automationTabId: tab.id, updatedAt: Date.now() } : null }));
  await chrome.storage.local.set({ [AUTOMATION_TAB_KEY]: tab.id });
  return tab.id;
}

export async function waitForTabLoad(tabId: number, timeoutMs = 20000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let timer: number | undefined;
    let settled = false;
    const cleanup = () => { chrome.tabs.onUpdated.removeListener(listener); if (timer) clearTimeout(timer); };
    const finish = () => { if (settled) return; settled = true; cleanup(); resolve(); };
    const listener = (updatedTabId: number, changeInfo: { status?: string }) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    void chrome.tabs.get(tabId).then((tab) => { if (tab.status === 'complete') finish(); }).catch(() => undefined);
    timer = setTimeout(() => { cleanup(); reject(new Error('TAB_LOAD_TIMEOUT')); }, timeoutMs) as unknown as number;
  });
}

export async function getPreviousActiveTabId(tabId: number): Promise<number | undefined> {
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return activeTab?.id && activeTab.id !== tabId ? activeTab.id : undefined;
}

export async function activateAutomationTab(tabId: number): Promise<void> {
  await chrome.tabs.update(tabId, { active: true });
}

export async function restoreActiveTab(tabId: number | undefined): Promise<void> {
  if (tabId) await chrome.tabs.update(tabId, { active: true }).catch(() => undefined);
}

export async function closeAutomationTabIfConfigured(session: AutomationSession): Promise<AppState> {
  const tabId = session.automationTabId;
  const shouldClose = Boolean(tabId && (session.closeTabOnComplete || !session.keepAutomationTabOpen));
  if (!tabId || !shouldClose) return getState();
  await chrome.tabs.remove(tabId).catch(() => undefined);
  await chrome.storage.local.remove(AUTOMATION_TAB_KEY);
  return updateRuntimeState((state) => state.session?.automationTabId === tabId
    ? { ...state, session: { ...state.session, automationTabId: undefined, updatedAt: Date.now() } }
    : state);
}

export async function ensureContentScript(tabId: number): Promise<void> {
  if (injectedContentTabs.has(tabId)) return;
  const existing = contentInjectionInFlight.get(tabId);
  if (existing) return existing;
  const injection = chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] })
    .then(() => { injectedContentTabs.add(tabId); })
    .finally(() => { contentInjectionInFlight.delete(tabId); });
  contentInjectionInFlight.set(tabId, injection);
  return injection;
}

export async function inspectTab(tabId: number): Promise<ContentInspection> {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'X_INSPECT' });
  } catch {
    await ensureContentScript(tabId);
    return await chrome.tabs.sendMessage(tabId, { type: 'X_INSPECT' });
  }
}

export async function waitForPublishReady(tabId: number, timeoutMs = 25000, intervalMs = 500): Promise<ContentInspection> {
  const deadline = Date.now() + timeoutMs;
  let lastInspection: ContentInspection | undefined;
  while (Date.now() < deadline) {
    lastInspection = await inspectTab(tabId);
    if (lastInspection.ok) return lastInspection;
    if (lastInspection.pageKind === 'LOGIN' || lastInspection.pageKind === 'CHALLENGE' || lastInspection.pageKind === 'UNKNOWN' || lastInspection.reason === 'X_DAILY_POST_LIMIT_REACHED') {
      throw new Error(lastInspection.reason ?? 'PUBLISH_CONTROLS_NOT_READY');
    }
    await wait(intervalMs);
  }
  throw new Error(lastInspection?.reason ?? 'PUBLISH_CONTROLS_NOT_READY');
}

async function assertOperationActive(itemId: string, operationId: string): Promise<void> {
  const state = await getState();
  const item = state.queue.find((candidate) => candidate.id === itemId);
  if (state.session?.status !== 'RUNNING' || item?.operationId !== operationId) throw new Error('AUTOMATION_INTERRUPTED');
}

/**
 * Resolves the workspace-scoped runner context used for LOCAL_RUNNER items.
 * The runner profile is bound 1:1 to the workspace id; the expected account is
 * the workspace-declared handle and is REQUIRED before any publish attempt.
 */
async function runnerContext(state: AppState, session: AutomationSession): Promise<{ workspaceId: string; profileId: string; expectedAccount?: string }> {
  const workspaceId = state.workspaceId ?? session.workspaceId ?? (await getMeta()).activeWorkspaceId;
  const workspace = (await listWorkspaces(true)).find((candidate) => candidate.id === workspaceId);
  return { workspaceId, profileId: workspaceId, expectedAccount: workspace?.expectedAccount };
}

/**
 * Persists a VERIFIED successful publish and schedules the next item.
 * finalStatus is PUBLISHED only — an unverified outcome never reaches this
 * function; it is routed through the conservative uncertain handler instead.
 */
async function settleSuccessfulPublish(session: AutomationSession, item: import('../domain/models').QueueItem, operationId: string, finalStatus: 'PUBLISHED', publishedPostUrl: string | undefined, options: { profile: Awaited<ReturnType<typeof getWorkspaceSettings>>; previousActiveTabId?: number } | { profile?: undefined; previousActiveTabId?: number } = {}): Promise<void> {
  const profile = options.profile ?? await getWorkspaceSettings(session.workspaceId ?? (await getMeta()).activeWorkspaceId);
  const finishedAt = Date.now();
  const nextItem = getNextPendingItem((await getState()).queue, item.id);
  const nextRunAt = nextItem ? getNextAllowedPublishingTime(finishedAt + profile.intervalMinutes * 60_000, profile.timezone, profile.publishingWindows) : undefined;
  const nextStatus = nextItem ? 'WAITING' : 'COMPLETED';
  const nextState = await updateRuntimeState((current) => ({
    ...current,
    queue: current.queue.map((candidate) => candidate.id === item.id ? { ...candidate, status: finalStatus, publishedAt: finishedAt, updatedAt: finishedAt, operationId: undefined, publishIntentId: undefined, publishStartedAt: undefined, publishSubmittedAt: undefined } : candidate),
    session: current.session ? { ...current.session, status: nextStatus, currentItemId: nextItem?.id, currentIndex: nextItem?.position ?? current.session.currentIndex, nextRunAt, completedAt: nextStatus === 'COMPLETED' ? finishedAt : current.session.completedAt, updatedAt: finishedAt } : null,
    history: [...current.history, { id: crypto.randomUUID(), workspaceId: current.workspaceId, sessionId: session.id, queueItemId: item.id, link: item.targetUrl, sourceUrl: item.targetUrl, publishedPostUrl, timestamp: finishedAt, attemptNumber: item.attempts + 1, action: 'PUBLISH', result: finalStatus }]
  }));
  await syncHistoricalSession(nextState, nextStatus === 'COMPLETED' ? 'COMPLETED' : 'WAITING');
  await chrome.alarms.clear(ALARM_NAME);
  if (nextRunAt) await chrome.alarms.create(ALARM_NAME, { when: nextRunAt, persistAcrossSessions: true });
  await restoreActiveTab(options.previousActiveTabId);
  const visibleState = nextStatus === 'COMPLETED' && nextState.session
    ? await closeAutomationTabIfConfigured(nextState.session)
    : nextState;
  if (nextStatus === 'COMPLETED' && nextState.workspaceId) await releaseAutomationOwner(nextState.workspaceId);
  if (nextStatus === 'COMPLETED') await notifyEvent('X-Pilot: اكتملت الجلسة', 'اكتملت جميع عناصر Queue.');
  await broadcast(visibleState);
}

async function processCurrentItem(): Promise<void> {
  const state = await getState();
  const session = state.session;
  if (!session || session.status !== 'RUNNING' || !session.currentItemId) return;
  const item = state.queue.find((candidate) => candidate.id === session.currentItemId);
  if (!item || shouldNeverRepublish(item) || !canStartItem(item.status)) return;
  const profile = await getWorkspaceSettings(state.workspaceId ?? session.workspaceId ?? (await getMeta()).activeWorkspaceId);
  const settings = await getSettings();
  const executionBackend = resolveSessionBackend(session, settings);
  const allowedAt = getNextAllowedPublishingTime(Date.now(), profile.timezone, profile.publishingWindows);
  if (allowedAt && allowedAt > Date.now() + 500) {
    const waiting = await updateRuntimeState((current) => ({ ...current, session: current.session ? { ...current.session, status: 'WAITING', nextRunAt: allowedAt, updatedAt: Date.now() } : null }));
    await chrome.alarms.clear(ALARM_NAME);
    await chrome.alarms.create(ALARM_NAME, { when: allowedAt, persistAcrossSessions: true });
    await notifyEvent('X-Pilot: خارج نافذة النشر', `سيستأنف النشر في ${new Date(allowedAt).toLocaleString()}`);
    await broadcast(waiting);
    return;
  }
  const operationId = crypto.randomUUID();
  const startedAt = Date.now();
  await updateRuntimeState((current) => ({
    ...current,
    queue: current.queue.map((candidate) => candidate.id === item.id ? { ...candidate, status: 'OPENING', attempts: candidate.attempts + 1, startedAt, operationId, updatedAt: startedAt } : candidate)
  }));
  let tabId: number | undefined;
  let previousActiveTabId: number | undefined;
  try {
    if (executionBackend === 'LOCAL_RUNNER') {
      // LOCAL_RUNNER path: the X page runs inside the Local Runner's own
      // headless Chromium. This branch never calls chrome.tabs — no X tab is
      // opened, activated, or focused in the user's daily Chrome.
      const context = await runnerContext(state, session);
      const expectedContent = publishContentFromIntentUrl(item.targetUrl);
      const inspection: RunnerInspection = await localRunnerBridge.inspect({ workspaceId: context.workspaceId, profileId: context.profileId, targetUrl: item.targetUrl, expectedAccount: context.expectedAccount, expectedContent });
      if (inspection.pageKind === 'LOGIN') throw new Error('RUNNER_LOGIN_REQUIRED');
      if (inspection.pageKind === 'CHALLENGE') throw new Error('RUNNER_CHALLENGE');
      if (inspection.dailyPostLimitReached) throw new Error('X_DAILY_POST_LIMIT_REACHED');
      if (!inspection.composerFound || !inspection.postButtonFound || !inspection.postButtonEnabled) throw new Error(inspection.reason ?? 'PUBLISH_CONTROLS_NOT_READY');
      if (context.expectedAccount && inspection.detectedAccount && inspection.detectedAccount !== context.expectedAccount) throw new Error('RUNNER_ACCOUNT_MISMATCH');
      if (!inspection.detectedAccount) throw new Error('RUNNER_ACCOUNT_UNKNOWN');
      if (expectedContent !== undefined && !inspection.contentMatches) throw new Error('RUNNER_CONTENT_MISMATCH');
      await assertOperationActive(item.id, operationId);
      await updateRuntimeState((current) => ({ ...current, queue: current.queue.map((candidate) => candidate.id === item.id ? { ...candidate, status: 'READY', updatedAt: Date.now() } : candidate) }));
      const lockedState = await getState();
      const lockedItem = lockedState.queue.find((candidate) => candidate.id === item.id);
      if (!lockedItem || lockedItem.operationId !== operationId || lockedItem.status !== 'READY') throw new Error('ITEM_LOCK_LOST');
      await assertOperationActive(item.id, operationId);
      await updateRuntimeState((current) => ({ ...current, queue: current.queue.map((candidate) => candidate.id === item.id ? { ...candidate, status: 'PUBLISHING', publishIntentId: operationId, publishStartedAt: Date.now(), updatedAt: Date.now() } : candidate) }));
      // Idempotent publish: the runner ledger keys on operationId, so a
      // duplicate request can never trigger a second post click.
      const runnerResult = await localRunnerBridge.publish({ workspaceId: context.workspaceId, profileId: context.profileId, operationId, targetUrl: item.targetUrl, expectedAccount: context.expectedAccount, expectedContent });
      await updateRuntimeState((current) => ({ ...current, queue: current.queue.map((candidate) => candidate.id === item.id && candidate.publishIntentId === operationId ? { ...candidate, publishSubmittedAt: Date.now(), updatedAt: Date.now() } : candidate) }));
      if (runnerResult.outcome === 'FAILED_BEFORE_SUBMIT' || runnerResult.outcome === 'REJECTED') {
        const reason = runnerResult.reason ?? 'PUBLISH_FAILED';
        // The durable runner ledger PROVES no post was created (a definite
        // pre-submit failure, or an explicit X-side refusal recorded with the
        // operation). Clear the publish-intent markers so the item settles
        // through the normal failure path instead of the uncertain handler.
        await updateRuntimeState((current) => ({ ...current, queue: current.queue.map((candidate) => candidate.id === item.id && candidate.publishIntentId === operationId ? { ...candidate, publishIntentId: undefined, publishStartedAt: undefined, publishSubmittedAt: undefined } : candidate) }));
        if (reason === 'RUNNER_DAILY_LIMIT') throw new Error('X_DAILY_POST_LIMIT_REACHED');
        throw new Error(runnerResult.outcome === 'REJECTED' ? `RUNNER_REJECTED:${reason}` : reason);
      }
      // CONFIRMED → verified success with attempt-scoped evidence.
      // UNVERIFIED → routed through the conservative uncertain handler
      // (PUBLISHED_UNVERIFIED + PAUSED) instead of advancing blindly.
      if (runnerResult.outcome !== 'CONFIRMED') throw new Error('PUBLISH_OUTCOME_UNVERIFIED');
      await settleSuccessfulPublish(session, item, operationId, 'PUBLISHED', runnerResult.postUrl, { profile });
      return;
    }
    tabId = await getOrCreateAutomationTab(session);
    previousActiveTabId = await getPreviousActiveTabId(tabId);
    await chrome.tabs.update(tabId, { url: item.targetUrl, active: false });
    await waitForTabLoad(tabId);
    await activateAutomationTab(tabId);
    await wait(300);
    await waitForPublishReady(tabId);
    await assertOperationActive(item.id, operationId);
    await updateRuntimeState((current) => ({ ...current, queue: current.queue.map((candidate) => candidate.id === item.id ? { ...candidate, status: 'READY', updatedAt: Date.now() } : candidate) }));
    const lockedState = await getState();
    const lockedItem = lockedState.queue.find((candidate) => candidate.id === item.id);
    if (!lockedItem || lockedItem.operationId !== operationId || lockedItem.status !== 'READY') throw new Error('ITEM_LOCK_LOST');
    await assertOperationActive(item.id, operationId);
    await updateRuntimeState((current) => ({ ...current, queue: current.queue.map((candidate) => candidate.id === item.id ? { ...candidate, status: 'PUBLISHING', publishIntentId: operationId, publishStartedAt: Date.now(), updatedAt: Date.now() } : candidate) }));
    // Attempt-scoped evidence: capture the status links visible BEFORE the
    // submit so that only links that newly appear after this click count as
    // proof. Composer disappearance alone is never treated as proof.
    const preEvidence = await chrome.tabs.sendMessage(tabId, { type: 'X_COLLECT_PUBLISH_EVIDENCE' }).catch(() => undefined) as { statusLinks?: string[]; account?: string } | undefined;
    const preStatusLinks = new Set(preEvidence?.statusLinks ?? []);
    const result = await chrome.tabs.sendMessage(tabId, { type: 'X_PUBLISH' });
    await updateRuntimeState((current) => ({ ...current, queue: current.queue.map((candidate) => candidate.id === item.id && candidate.publishIntentId === operationId ? { ...candidate, publishSubmittedAt: Date.now(), updatedAt: Date.now() } : candidate) }));
    await wait(1800);
    const after = await inspectTab(tabId);
    const postEvidence = await chrome.tabs.sendMessage(tabId, { type: 'X_COLLECT_PUBLISH_EVIDENCE' }).catch(() => undefined) as { statusLinks?: string[]; toastVisible?: boolean; account?: string } | undefined;
    if (after.dailyPostLimitReached || after.reason === 'X_DAILY_POST_LIMIT_REACHED') throw new Error('X_DAILY_POST_LIMIT_REACHED');
    if (!result?.ok) throw new Error(result?.reason ?? 'PUBLISH_FAILED');
    const newStatusLink = postEvidence?.statusLinks?.find((link) => !preStatusLinks.has(link));
    const confirmationToast = postEvidence?.toastVisible === true;
    if (!newStatusLink && !confirmationToast) {
      // No attempt-bound evidence: the submit may or may not have landed.
      // Route through the uncertain handler (PUBLISHED_UNVERIFIED + PAUSED)
      // instead of guessing success from the composer state.
      throw new Error('PUBLISH_OUTCOME_UNVERIFIED');
    }
    await settleSuccessfulPublish(session, item, operationId, 'PUBLISHED', newStatusLink, { profile, previousActiveTabId });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'UNKNOWN_ERROR';
    if (message === 'X_DAILY_POST_LIMIT_REACHED') {
      const pausedState = await updateRuntimeState((currentState) => ({
        ...currentState,
        queue: currentState.queue.map((candidate) => candidate.id === item.id && candidate.operationId === operationId
          ? { ...candidate, status: 'PENDING', attempts: item.attempts, lastError: message, operationId: undefined, publishIntentId: undefined, publishStartedAt: undefined, publishSubmittedAt: undefined, updatedAt: Date.now() }
          : candidate),
        session: currentState.session ? { ...currentState.session, status: 'PAUSED', currentItemId: item.id, nextRunAt: undefined, updatedAt: Date.now() } : null,
        history: [...currentState.history, { id: crypto.randomUUID(), workspaceId: currentState.workspaceId, sessionId: session.id, queueItemId: item.id, link: item.targetUrl, sourceUrl: item.targetUrl, timestamp: Date.now(), attemptNumber: item.attempts, action: 'PUBLISH', result: 'PAUSED', error: message }]
      }));
      await syncHistoricalSession(pausedState, 'PAUSED', message);
      await chrome.alarms.clear(ALARM_NAME);
      await restoreActiveTab(previousActiveTabId);
      await notifyEvent('X-Pilot: تم إيقاف النشر', 'وصل حساب X إلى الحد الأقصى للمنشورات اليومية. لم يتم الانتقال إلى العنصر التالي.');
      await broadcast(pausedState);
      return;
    }
    if (message.includes('LOGIN') || message.includes('PUBLISH_CONTROLS_NOT_READY')) await notifyEvent('X-Pilot: مطلوب تدخل', message.includes('LOGIN') ? 'تسجيل الدخول إلى X مطلوب.' : 'تعذر العثور على عناصر النشر.');
    if (message.includes('CHALLENGE') || message.includes('CAPTCHA')) await notifyEvent('X-Pilot: تحدٍ أمني', 'تم اكتشاف CAPTCHA أو Challenge وتوقفت الجلسة.');
    if (message === 'AUTOMATION_INTERRUPTED') {
      const interruptedState = await updateRuntimeState((current) => ({
        ...current,
        queue: current.queue.map((candidate) => candidate.id === item.id && candidate.operationId === operationId && candidate.status !== 'PUBLISHING' ? { ...candidate, status: 'PENDING', operationId: undefined, updatedAt: Date.now() } : candidate)
      }));
      await restoreActiveTab(previousActiveTabId);
      await broadcast(interruptedState);
      return;
    }
    const current = await getState();
    const latestItem = current.queue.find((candidate) => candidate.id === item.id);
    if (latestItem?.status === 'PUBLISHING' && latestItem.publishIntentId === operationId && message !== 'X_DAILY_POST_LIMIT_REACHED') {
      const uncertainAt = Date.now();
      const uncertain = await updateRuntimeState((currentState) => ({
        ...currentState,
        queue: currentState.queue.map((candidate) => candidate.id === item.id && candidate.publishIntentId === operationId
          ? { ...candidate, status: 'PUBLISHED_UNVERIFIED', publishedAt: candidate.publishedAt ?? uncertainAt, lastError: 'PUBLISH_OUTCOME_UNVERIFIED', operationId: undefined, updatedAt: uncertainAt }
          : candidate),
        session: currentState.session ? { ...currentState.session, status: 'PAUSED', currentItemId: item.id, nextRunAt: undefined, updatedAt: uncertainAt } : null,
        history: [...currentState.history, { id: crypto.randomUUID(), workspaceId: currentState.workspaceId, sessionId: session.id, queueItemId: item.id, link: item.targetUrl, sourceUrl: item.targetUrl, timestamp: uncertainAt, attemptNumber: item.attempts, action: 'PUBLISH', result: 'PUBLISHED_UNVERIFIED', error: 'PUBLISH_OUTCOME_UNVERIFIED' }]
      }));
      await syncHistoricalSession(uncertain, 'PAUSED', 'PUBLISH_OUTCOME_UNVERIFIED');
      await chrome.alarms.clear(ALARM_NAME);
      await restoreActiveTab(previousActiveTabId);
      await notifyEvent('X-Pilot: مطلوب تدخل', 'نتيجة النشر غير مؤكدة. تم إيقاف الجلسة لمنع إعادة النشر.');
      await broadcast(uncertain);
      return;
    }
    if (current.session?.status !== 'RUNNING' || latestItem?.operationId !== operationId) {
      await restoreActiveTab(previousActiveTabId);
      return;
    }
    const exhausted = message.startsWith('RUNNER_REJECTED') || !latestItem || latestItem.attempts >= session.maxRetries + 1;
    const failedStatus = exhausted ? 'FAILED' : 'PENDING';
    const nextItem = exhausted && session.failureBehavior === 'CONTINUE' ? getNextPendingItem(current.queue, item.id) : undefined;
    const nextRunAt = !exhausted || nextItem ? Date.now() + session.intervalMinutes * 60_000 : undefined;
    const nextStatus = exhausted && session.failureBehavior === 'PAUSE' ? 'PAUSED' : nextItem || !exhausted ? 'WAITING' : 'COMPLETED';
    const nextItemId = nextItem?.id ?? (!exhausted ? item.id : undefined);
    const nextItemIndex = nextItem?.position ?? (!exhausted ? item.position : current.session?.currentIndex);
    const failedState = await updateRuntimeState((currentState) => ({
      ...currentState,
      queue: currentState.queue.map((candidate) => candidate.id === item.id ? { ...candidate, status: failedStatus, lastError: message, operationId: undefined, updatedAt: Date.now() } : candidate),
      session: currentState.session ? { ...currentState.session, status: nextStatus, currentItemId: nextItemId, currentIndex: nextItemIndex ?? currentState.session.currentIndex, nextRunAt, completedAt: nextStatus === 'COMPLETED' ? Date.now() : currentState.session.completedAt, updatedAt: Date.now() } : null,
      history: [...currentState.history, { id: crypto.randomUUID(), workspaceId: currentState.workspaceId, sessionId: session.id, queueItemId: item.id, link: item.targetUrl, sourceUrl: item.targetUrl, timestamp: Date.now(), attemptNumber: item.attempts + 1, action: 'PUBLISH', result: failedStatus, error: message }]
    }));
    await syncHistoricalSession(failedState, nextStatus === 'COMPLETED' ? 'COMPLETED' : nextStatus === 'PAUSED' ? 'PAUSED' : 'WAITING', message);
    await chrome.alarms.clear(ALARM_NAME);
    if (nextRunAt) await chrome.alarms.create(ALARM_NAME, { when: nextRunAt, persistAcrossSessions: true });
    await restoreActiveTab(previousActiveTabId);
    const visibleState = nextStatus === 'COMPLETED' && failedState.session
      ? await closeAutomationTabIfConfigured(failedState.session)
      : failedState;
    if (nextStatus === 'COMPLETED' && failedState.workspaceId) await releaseAutomationOwner(failedState.workspaceId);
    if (failedStatus === 'FAILED') await notifyEvent('X-Pilot: فشل عنصر', `فشل Item #${item.position}: ${message}`);
    await broadcast(visibleState);
  }
}

async function advanceSession(): Promise<void> {
  const state = await getState();
  if (!state.session || state.session.status !== 'WAITING') return;
  const next = getNextRunnableItem(state.queue, state.session.currentItemId);
    if (!next) {
      const completed = await updateRuntimeState((current) => ({ ...current, session: current.session ? { ...current.session, status: 'COMPLETED', completedAt: Date.now(), nextRunAt: undefined, updatedAt: Date.now() } : null }));
    await syncHistoricalSession(completed, 'COMPLETED');
    const visibleState = completed.session ? await closeAutomationTabIfConfigured(completed.session) : completed;
    if (completed.workspaceId) await releaseAutomationOwner(completed.workspaceId);
    await broadcast(visibleState);
    return;
  }
  const running = await updateRuntimeState((current) => ({ ...current, session: current.session ? { ...current.session, status: 'RUNNING', currentItemId: next.id, currentIndex: next.position, nextRunAt: undefined, updatedAt: Date.now() } : null }));
  await broadcast(running);
  await processCurrentItem();
}

export async function performPreflight(workspaceId: string) {
  const state = await getWorkspaceState(workspaceId);
  const meta = await getMeta();
  const workspace = (await listWorkspaces(true)).find((item) => item.id === workspaceId);
  const settings = await getSettings();
  const permissionsGranted = await chrome.permissions.contains({ origins: ['https://x.com/*', 'https://twitter.com/*'] }).catch(() => false);
  const executionBackend = resolveSessionBackend(state.session, settings);
  let xInspection: ContentInspection | null = null;
  let temporaryTabId: number | undefined;
  let previousActiveTabId: number | undefined;
  try {
    const firstItem = state.queue.find((item) => canStartItem(item.status) && !item.duplicateStatus?.includes('PUBLISHED'));
    const targetUrl = firstItem?.targetUrl?.trim() || 'https://x.com/home';
    const parsed = new URL(targetUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || !/(^|\.)x\.com$|(^|\.)twitter\.com$/i.test(parsed.hostname)) throw new Error('PREFLIGHT_INVALID_X_ITEM_URL');
    if (executionBackend === 'LOCAL_RUNNER') {
      // LOCAL_RUNNER preflight inspects through the runner's headless browser;
      // no X tab is ever opened in the user's daily Chrome.
      const expectedContent = publishContentFromIntentUrl(targetUrl);
      const inspection = await localRunnerBridge.inspect({ workspaceId, profileId: workspaceId, targetUrl, expectedAccount: workspace?.expectedAccount, expectedContent });
      xInspection = {
        ok: Boolean(inspection.composerFound && inspection.contentPresent && inspection.postButtonFound && inspection.postButtonEnabled && inspection.contentMatches && inspection.detectedAccount && (!workspace?.expectedAccount || inspection.detectedAccount === workspace.expectedAccount)),
        pageKind: inspection.pageKind,
        composerFound: inspection.composerFound,
        contentPresent: inspection.contentPresent,
        postButtonFound: inspection.postButtonFound,
        postButtonEnabled: inspection.postButtonEnabled,
        reason: inspection.dailyPostLimitReached ? 'X_DAILY_POST_LIMIT_REACHED'
          : inspection.pageKind === 'LOGIN' ? 'NOT_LOGGED_IN'
          : inspection.pageKind === 'CHALLENGE' ? 'CAPTCHA_OR_SECURITY_CHALLENGE'
          : workspace?.expectedAccount && inspection.detectedAccount && inspection.detectedAccount !== workspace.expectedAccount ? 'RUNNER_ACCOUNT_MISMATCH'
          : !inspection.detectedAccount ? 'RUNNER_ACCOUNT_UNKNOWN'
          : inspection.contentMatches === false && expectedContent !== undefined ? 'RUNNER_CONTENT_MISMATCH'
          : inspection.reason ?? 'PUBLISH_CONTROLS_NOT_READY',
        dailyPostLimitReached: inspection.dailyPostLimitReached,
      };
    } else {
      const temporary = await chrome.tabs.create({ url: 'about:blank', active: false });
      if (!temporary.id) throw new Error('PREFLIGHT_X_TAB_CREATE_FAILED');
      temporaryTabId = temporary.id;
      previousActiveTabId = await getPreviousActiveTabId(temporary.id);
      await chrome.tabs.update(temporary.id, { url: targetUrl, active: false });
      await waitForTabLoad(temporary.id);
      await activateAutomationTab(temporary.id);
      await wait(300);
      xInspection = await inspectTab(temporary.id);
    }
  } catch (error) {
    xInspection = { ok: false, pageKind: 'ERROR', composerFound: false, contentPresent: false, postButtonFound: false, postButtonEnabled: false, reason: error instanceof Error ? error.message : 'PREFLIGHT_X_INSPECTION_FAILED' };
  } finally {
    await restoreActiveTab(previousActiveTabId);
    if (temporaryTabId !== undefined) await chrome.tabs.remove(temporaryTabId).catch(() => undefined);
  }
  return runPreflight({ workspace, queue: state.queue, banks: state.banks, automationWorkspaceId: meta.automationWorkspaceId, alarmsAvailable: Boolean(chrome.alarms), permissionsGranted, settings, xInspection });
}

export async function scheduleSession(workspaceId: string, startAt: number): Promise<AppState> {
  if (!Number.isFinite(startAt) || startAt <= Date.now()) throw new Error('SCHEDULE_START_MUST_BE_IN_FUTURE');
  const preflight = await performPreflight(workspaceId);
  if (!preflight.ready) { await notifyEvent('X-Pilot: فشل فحص الجاهزية', preflight.summaryKey); throw new Error(`PREFLIGHT_FAILED:${preflight.summaryKey}`); }
  await claimAutomationOwner(workspaceId);
  const settings = await getWorkspaceSettings(workspaceId);
  const scheduled = await updateWorkspaceState(workspaceId, (current) => ({
    ...current,
    session: {
      ...(current.session ?? {
        id: crypto.randomUUID(), workspaceId, bankId: current.banks.find((bank) => !bank.archived)?.id, bankUrl: current.banks.find((bank) => !bank.archived)?.url ?? '', status: 'SCHEDULED' as const, currentIndex: current.queue.find((item) => item.status === 'PENDING')?.position ?? 0, total: current.queue.length, version: 1,
      }),
      ...settings,
      workspaceId,
      executionBackend: normalizeExecutionBackend(settings.executionBackend),
      status: 'SCHEDULED',
      scheduledStartAt: startAt,
      nextRunAt: startAt,
      currentItemId: current.session?.currentItemId ?? current.queue.find((item) => item.status === 'PENDING')?.id,
      updatedAt: Date.now(),
    },
  }));
  await chrome.alarms.clear(SCHEDULE_ALARM_NAME);
  await chrome.alarms.create(SCHEDULE_ALARM_NAME, { when: startAt, persistAcrossSessions: true });
  const state: AppState = { workspaceId: scheduled.workspaceId, queue: scheduled.queue, session: scheduled.session, history: scheduled.history };
  await notifyEvent('X-Pilot: جلسة مجدولة', `ستبدأ الجلسة في ${new Date(startAt).toLocaleString()}`);
  await broadcast(state);
  return state;
}

async function handleScheduledStart(): Promise<void> {
  const state = await getState();
  if (!state.session || state.session.status !== 'SCHEDULED') return;
  if ((state.session.scheduledStartAt ?? 0) > Date.now()) {
    await chrome.alarms.create(SCHEDULE_ALARM_NAME, { when: state.session.scheduledStartAt!, persistAcrossSessions: true });
    return;
  }
  const item = state.session.currentItemId ? state.queue.find((candidate) => candidate.id === state.session!.currentItemId) : undefined;
  if (!item || !canStartItem(item.status)) {
    await chrome.alarms.clear(SCHEDULE_ALARM_NAME);
    const failed = await updateRuntimeState((current) => ({ ...current, session: current.session ? { ...current.session, status: 'FAILED', scheduledStartAt: undefined, nextRunAt: undefined, updatedAt: Date.now() } : null }));
    await notifyEvent('X-Pilot: فشل بدء الجدولة', 'لا يوجد عنصر Queue قابل للتشغيل عند موعد الجدولة.');
    await broadcast(failed);
    return;
  }
  const running = await updateRuntimeState((current) => ({ ...current, session: current.session ? { ...current.session, status: 'RUNNING', startedAt: Date.now(), scheduledStartAt: undefined, nextRunAt: undefined, updatedAt: Date.now() } : null }));
  await chrome.alarms.clear(SCHEDULE_ALARM_NAME);
  await notifyEvent('X-Pilot: بدأت الجلسة', 'بدأت جلسة النشر المجدولة.');
  let ready = running;
  if (running.workspaceId && running.session && !running.session.historicalSessionId) {
    const historical = createHistoricalSession(running.session, running.queue);
    await saveHistoricalSession(running.workspaceId, historical);
    ready = await updateRuntimeState((current) => ({ ...current, session: current.session ? { ...current.session, historicalSessionId: historical.id, updatedAt: Date.now() } : null }));
  }
  await broadcast(ready);
  await processCurrentItem();
}

async function handleAlarmFailure(alarmName: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : 'ALARM_HANDLER_FAILED';
  console.error('X-Pilot alarm handler failed', { alarmName, message });
  try {
    const state = await getState();
    const session = state.session;
    if (!session || !['RUNNING', 'WAITING', 'SCHEDULED'].includes(session.status)) return;
    const alarmStatus = session.status === 'SCHEDULED' ? 'SCHEDULED' : 'WAITING';
    const retryAt = alarmStatus === 'WAITING' ? session.nextRunAt : session.scheduledStartAt;
    const decision = decideAlarmFailure(alarmStatus, retryAt, session.alarmFailureCount ?? 0, Date.now());
    if (decision.action === 'RETRY') {
      await chrome.alarms.create(decision.alarmName, { when: decision.when, persistAcrossSessions: true });
      const retried = await updateRuntimeState((current) => ({ ...current, session: current.session ? { ...current.session, status: current.session.status === 'RUNNING' ? 'WAITING' : current.session.status, nextRunAt: current.session.status === 'RUNNING' ? decision.when : current.session.nextRunAt, alarmFailureCount: decision.failureCount, lastAlarmError: message, updatedAt: Date.now() } : null }));
      await notifyEvent('X-Pilot: فشل مؤقت', `فشل Alarm وسيُعاد المحاولة (${decision.failureCount}/3).`);
      await broadcast(retried);
      return;
    }
    const failed = await updateRuntimeState((current) => ({ ...current, session: current.session ? { ...current.session, status: 'FAILED', nextRunAt: undefined, scheduledStartAt: undefined, alarmFailureCount: decision.failureCount, lastAlarmError: message, updatedAt: Date.now() } : null }));
    await chrome.alarms.clear(alarmName);
    if (failed.workspaceId) await releaseAutomationOwner(failed.workspaceId);
    await notifyEvent('X-Pilot: فشل الجدولة', 'تعذر تنفيذ Alarm بعد محاولات محدودة. راجع الجلسة ثم أعد التشغيل يدويًا.');
    await broadcast(failed);
  } catch (fallbackError) {
    console.error('X-Pilot alarm failure recovery failed', fallbackError);
  }
}

async function handleAlarm(alarm: chrome.alarms.Alarm): Promise<void> {
  const state = await getState();
  const session = state.session;
  if (alarm.name === ALARM_NAME && session?.status === 'WAITING') {
    if (session.nextRunAt && session.nextRunAt > Date.now()) return;
    await advanceSession();
  }
  if (alarm.name === SCHEDULE_ALARM_NAME && session?.status === 'SCHEDULED') {
    if (session.scheduledStartAt && session.scheduledStartAt > Date.now()) return;
    await handleScheduledStart();
  }
}

chrome.alarms.onAlarm.addListener

chrome.alarms.onAlarm.addListener((alarm) => { void handleAlarm(alarm).catch((error) => handleAlarmFailure(alarm.name, error)); });

export async function startSession(messageWorkspaceId?: string): Promise<unknown> {
  const workspaceId = messageWorkspaceId ?? (await getMeta()).activeWorkspaceId;
  const startToken = await acquireStartLock(workspaceId);
  const leaseHeartbeat = setInterval(() => { void renewStartLock(startToken).then((healthy) => { if (!healthy) console.error('X-Pilot START lease lost', { workspaceId }); }).catch((error) => console.error('X-Pilot START lease renewal failed', error)); }, 5_000);
  try {
    const existing = await getWorkspaceState(workspaceId);
    if (existing.session && ['RUNNING', 'WAITING', 'PAUSED', 'SCHEDULED'].includes(existing.session.status)) throw new Error('START_ALREADY_ACTIVE');
    const preflight = await performPreflight(workspaceId);
    if (!preflight.ready) { await notifyEvent('X-Pilot: فشل فحص الجاهزية', preflight.summaryKey); throw new Error(`PREFLIGHT_FAILED:${preflight.summaryKey}`); }
    await claimAutomationOwner(workspaceId);
    const settings = await getWorkspaceSettings(workspaceId);
    const state = await updateRuntimeState((current) => {
      const firstItem = current.queue.find((item) => canStartItem(item.status) && !item.duplicateStatus?.includes('PUBLISHED'));
      const currentItem = current.session?.currentItemId && current.queue.some((item) => item.id === current.session?.currentItemId && canStartItem(item.status))
        ? current.session.currentItemId
        : firstItem?.id;
      const session: AutomationSession = current.session ?? {
        id: crypto.randomUUID(), workspaceId, bankUrl: '', ...settings,
        status: 'RUNNING' as const, currentIndex: firstItem?.position ?? 0, total: current.queue.length, version: 1, updatedAt: Date.now(),
      };
      return { ...current, session: { ...session, ...settings, workspaceId, executionBackend: normalizeExecutionBackend(settings.executionBackend), status: 'RUNNING', startedAt: session.startedAt ?? Date.now(), currentItemId: currentItem, currentIndex: current.queue.find((item) => item.id === currentItem)?.position ?? session.currentIndex, total: current.queue.length, updatedAt: Date.now() } };
    });
    if (state.workspaceId && state.session && !state.session.historicalSessionId) {
      const historical = createHistoricalSession(state.session, state.queue);
      await saveHistoricalSession(state.workspaceId, historical);
      const linked = await updateRuntimeState((current) => ({ ...current, session: current.session ? { ...current.session, historicalSessionId: historical.id, updatedAt: Date.now() } : null }));
      await broadcast(linked); await processCurrentItem(); return getState();
    }
    await broadcast(state); await processCurrentItem(); return getState();
  } finally {
    clearInterval(leaseHeartbeat);
    await releaseStartLock(startToken);
  }

}

/**
 * Best-effort cancellation of an in-flight LOCAL_RUNNER operation.
 * Cancellation is effective only BEFORE the submit click; once the submit may
 * have reached X the outcome is settled by the runner ledger (recorded result
 * or PUBLISHED_UNVERIFIED) — stop/pause never claims a possibly-sent post was
 * cancelled, and never returns the item to PENDING after a possible submit.
 */
async function cancelInFlightRunnerOperation(): Promise<void> {
  try {
    const state = await getState();
    const session = state.session;
    if (!session?.workspaceId) return;
    const settings = await getSettings();
    if (resolveSessionBackend(session, settings) !== 'LOCAL_RUNNER') return;
    const inFlight = state.queue.find((item) => item.id === session.currentItemId && item.status === 'PUBLISHING' && item.operationId && item.publishIntentId);
    if (!inFlight?.operationId) return;
    await localRunnerBridge.cancel({ workspaceId: session.workspaceId, profileId: session.workspaceId, operationId: inFlight.operationId });
  } catch {
    // Cancellation is advisory: the durable ledger + conservative recovery
    // own the final decision when the runner cannot be reached.
  }
}

export async function pauseSession(): Promise<AppState> {
  await cancelInFlightRunnerOperation();
  await chrome.alarms.clear(ALARM_NAME);
  const paused = await updateRuntimeState((state) => ({
    ...state,
    queue: state.queue.map((item) => item.id === state.session?.currentItemId && (item.status === 'OPENING' || item.status === 'READY') ? { ...item, status: 'PENDING', operationId: undefined, updatedAt: Date.now() } : item),
    session: state.session ? { ...state.session, status: 'PAUSED', pausedAt: Date.now(), nextRunAt: state.session.status === 'WAITING' ? state.session.nextRunAt : undefined, updatedAt: Date.now() } : null
  }));
  await syncHistoricalSession(paused, 'PAUSED');
  await notifyEvent('X-Pilot: توقفت Queue مؤقتًا', 'تم إيقاف Queue مؤقتًا.');
  await broadcast(paused);
  return paused;

}

export async function resumeSession(): Promise<AppState> {
  const current = await getState();
  if (!current.session || current.session.status !== 'PAUSED') return current;
  const nextRunAt = current.session.nextRunAt;
  const hasFutureAlarm = Boolean(nextRunAt && nextRunAt > Date.now());
  if (hasFutureAlarm && nextRunAt) {
    await chrome.alarms.create(ALARM_NAME, { when: nextRunAt, persistAcrossSessions: true });
    const waiting = await updateRuntimeState((state) => ({ ...state, session: state.session ? { ...state.session, status: 'WAITING', pausedAt: undefined, updatedAt: Date.now() } : null }));
    await broadcast(waiting);
    return waiting;
  }
  const currentItem = current.queue.find((item) => item.id === current.session?.currentItemId && canStartItem(item.status));
  const next = currentItem ?? getNextPendingItem(current.queue);
  const running = await updateRuntimeState((state) => ({ ...state, session: state.session ? { ...state.session, status: 'RUNNING', pausedAt: undefined, nextRunAt: undefined, currentItemId: next?.id, currentIndex: next?.position ?? state.session.currentIndex, updatedAt: Date.now() } : null }));
  await broadcast(running);
  if (next) await processCurrentItem();
  return running;

}

export async function stopSession(): Promise<AppState> {
  await cancelInFlightRunnerOperation();
  await chrome.alarms.clear(ALARM_NAME);
  await chrome.alarms.clear(SCHEDULE_ALARM_NAME);
  const stopped = await updateRuntimeState((state) => ({
    ...state,
    queue: state.queue.map((item) => item.id === state.session?.currentItemId && (item.status === 'OPENING' || item.status === 'READY') ? { ...item, status: 'PENDING', operationId: undefined, updatedAt: Date.now() } : item),
    session: state.session ? { ...state.session, status: 'STOPPED', scheduledStartAt: undefined, nextRunAt: undefined, updatedAt: Date.now() } : null
  }));
  await syncHistoricalSession(stopped, 'STOPPED');
  const result = stopped.session ? await closeAutomationTabIfConfigured(stopped.session) : stopped;
  if (result.workspaceId) await releaseAutomationOwner(result.workspaceId);
  return result;

}

export async function startOverSession(): Promise<AppState & { resetCount: number }> {
  const now = Date.now();
  await chrome.alarms.clear(ALARM_NAME);
  await chrome.alarms.clear(SCHEDULE_ALARM_NAME);
  let resetCount = 0;
  const restarted = await updateRuntimeState((state) => {
    resetCount = countStartOverResets(state.queue);
    const queue = buildStartOverQueue(state.queue, now);
    return { ...state, queue, session: state.session ? { ...state.session, status: 'STOPPED' as const, scheduledStartAt: undefined, nextRunAt: undefined, currentItemId: undefined, currentIndex: 0, total: queue.length, updatedAt: now } : null };
  });
  if (restarted.session) await syncHistoricalSession(restarted, 'STOPPED');
  const closed = restarted.session ? await closeAutomationTabIfConfigured(restarted.session) : restarted;
  if (closed.workspaceId) await releaseAutomationOwner(closed.workspaceId);
  const next: AppState = { workspaceId: closed.workspaceId, queue: closed.queue, session: closed.session, history: closed.history };
  await broadcast(next);
  return { ...next, resetCount };

}

export async function cancelScheduledStart(): Promise<AppState> {
  await chrome.alarms.clear(SCHEDULE_ALARM_NAME);
  const cancelled = await updateRuntimeState((current) => ({ ...current, session: current.session?.status === 'SCHEDULED' ? { ...current.session, status: 'STOPPED', scheduledStartAt: undefined, nextRunAt: undefined, updatedAt: Date.now() } : current.session }));
  await releaseAutomationOwner(cancelled.workspaceId ?? (await getMeta()).activeWorkspaceId);
  await notifyEvent('X-Pilot: أُلغيت الجدولة', 'تم إلغاء جلسة النشر المجدولة.');
  await broadcast(cancelled);
  return cancelled;

}
