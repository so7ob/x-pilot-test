import type { QueueItem, Settings, TweetBank, Workspace } from './models';

export type PreflightCheckStatus = 'PASS' | 'WARN' | 'FAIL';
export interface PreflightCheck { id: string; status: PreflightCheckStatus; messageKey: string; detailsKey?: string; params?: Record<string, string | number>; blocking: boolean; }
export interface PreflightCounts { total: number; ready: number; published: number; failed: number; skipped: number; duplicates: number; publishedDuplicates: number; invalid: number; }
export interface PreflightResult { ready: boolean; checkedAt: number; workspaceId: string; summaryKey: string; summaryParams: Record<string, string | number>; checks: PreflightCheck[]; counts: PreflightCounts; }

interface PreflightInput { workspace?: Workspace; queue: QueueItem[]; banks: TweetBank[]; automationWorkspaceId?: string; alarmsAvailable: boolean; permissionsGranted: boolean; settings: Settings; xInspection?: { pageKind: 'X' | 'LOGIN' | 'CHALLENGE' | 'ERROR' | 'UNKNOWN'; composerFound: boolean; contentPresent: boolean; postButtonFound: boolean; postButtonEnabled: boolean; reason?: string } | null; backend?: 'CHROME_TAB' | 'LOCAL_RUNNER'; now?: number; }

export function runPreflight(input: PreflightInput): PreflightResult {
  const now = input.now ?? Date.now();
  const checks: PreflightCheck[] = [];
  const add = (id: string, status: PreflightCheckStatus, messageKey: string, detailsKey: string | undefined, params: Record<string, string | number> | undefined, blocking: boolean) => checks.push({ id, status, messageKey, detailsKey, params, blocking });
  const workspace = input.workspace;
  const published = input.queue.filter((item) => item.status === 'PUBLISHED' || item.status === 'PUBLISHED_UNVERIFIED').length;
  const failed = input.queue.filter((item) => item.status === 'FAILED').length;
  const skipped = input.queue.filter((item) => item.status === 'SKIPPED').length;
  const invalid = input.queue.filter((item) => !/^https?:\/\/\S+$/i.test(item.targetUrl.trim())).length;
  const duplicateItems = input.queue.filter((item) => item.duplicateStatus === 'DUPLICATE').length;
  const publishedDuplicates = input.queue.filter((item) => item.duplicateStatus === 'PUBLISHED_DUPLICATE').length;
  const runnable = input.queue.filter((item) => ['PENDING', 'FAILED'].includes(item.status) && !item.duplicateStatus?.includes('PUBLISHED')).length;

  if (workspace && !workspace.archived) add('workspace', 'PASS', 'preflight.workspaceValid', undefined, undefined, false);
  else add('workspace', 'FAIL', 'preflight.noWorkspace', undefined, undefined, true);
  if (input.queue.length > 0) add('queue-not-empty', 'PASS', 'preflight.queueNotEmpty', undefined, { count: input.queue.length }, false);
  else add('queue-not-empty', 'FAIL', 'queue.empty', 'preflight.queueHint', undefined, true);
  if (runnable > 0) add('runnable-items', 'PASS', 'preflight.queueNotEmpty', undefined, { count: runnable }, false);
  else add('runnable-items', 'FAIL', 'queue.empty', undefined, undefined, true);
  if (!input.automationWorkspaceId || input.automationWorkspaceId === workspace?.id) add('automation-owner', 'PASS', 'preflight.workspaceValid', undefined, undefined, false);
  else add('automation-owner', 'FAIL', 'preflight.automationOwner', undefined, undefined, true);
  if (invalid > 0) add('queue-validity', 'FAIL', 'preflight.invalidLinks', 'preflight.queueHint', { count: invalid }, true);
  else add('queue-validity', 'PASS', 'preflight.queueValid', undefined, undefined, false);
  if (input.banks.some((bank) => !bank.archived && /^https?:\/\/\S+$/i.test(bank.url))) add('bank-metadata', 'PASS', 'preflight.bankValid', undefined, undefined, false);
  else add('bank-metadata', 'WARN', 'preflight.noBank', 'preflight.bankHint', undefined, false);
  if (duplicateItems > 0 || publishedDuplicates > 0) {
    const blocking = input.settings.duplicatePolicy === 'BLOCK' && publishedDuplicates > 0;
    add('duplicates', blocking ? 'FAIL' : 'WARN', 'preflight.duplicateCount', 'preflight.duplicateHint', { count: duplicateItems + publishedDuplicates, policy: input.settings.duplicatePolicy }, blocking);
  } else add('duplicates', 'PASS', 'preflight.duplicates', undefined, undefined, false);
  if (input.settings.intervalMinutes > 0) add('interval', 'PASS', 'preflight.intervalValid', undefined, { count: input.settings.intervalMinutes }, false);
  else add('interval', 'FAIL', 'preflight.intervalInvalid', undefined, undefined, true);
  if (input.settings.maxRetries >= 0 && input.settings.maxRetries <= 10) add('retry-config', 'PASS', 'preflight.retries', undefined, { count: input.settings.maxRetries }, false);
  else add('retry-config', 'FAIL', 'preflight.retriesInvalid', undefined, undefined, true);
  add('permissions', input.permissionsGranted ? 'PASS' : 'FAIL', input.permissionsGranted ? 'preflight.permissions' : 'preflight.noPermissions', undefined, undefined, !input.permissionsGranted);
  add('alarms', input.alarmsAvailable ? 'PASS' : 'FAIL', input.alarmsAvailable ? 'preflight.alarms' : 'preflight.noAlarms', undefined, undefined, !input.alarmsAvailable);
  if (!input.xInspection) add('x-adapter', 'WARN', 'preflight.notInspected', 'preflight.queueHint', undefined, false);
  else if (input.xInspection.pageKind === 'LOGIN') {
    // The login that matters depends on the engine: CHROME_TAB uses the daily
    // browser session (the runner login lives in a separate browser), while
    // LOCAL_RUNNER uses the runner profile set up from the Settings card.
    const loginHint = input.backend === 'CHROME_TAB' ? 'preflight.loginChromeTabHint' : input.backend === 'LOCAL_RUNNER' ? 'preflight.loginRunnerHint' : undefined;
    add('x-adapter', 'FAIL', 'preflight.login', loginHint, undefined, true);
  }
  else if (input.xInspection.pageKind === 'CHALLENGE') add('x-adapter', 'FAIL', 'preflight.challenge', undefined, undefined, true);
  else if (input.xInspection.pageKind !== 'X') add('x-adapter', 'FAIL', 'preflight.adapter', 'preflight.adapterReason', { reason: input.xInspection.reason ?? 'UNKNOWN_PAGE' }, true);
  else if (!input.xInspection.composerFound || !input.xInspection.postButtonFound || !input.xInspection.postButtonEnabled) add('x-adapter', 'FAIL', 'preflight.composer', 'preflight.adapterReason', { reason: input.xInspection.reason ?? 'PUBLISH_CONTROLS_NOT_READY' }, true);
  else add('x-adapter', 'PASS', 'preflight.adapterReady', undefined, undefined, false);

  const blockingFailures = checks.filter((check) => check.status === 'FAIL' && check.blocking);
  const ready = blockingFailures.length === 0 && runnable > 0;
  const summaryKey = ready ? 'preflight.ready' : 'preflight.notReady';
  const summaryParams: Record<string, string | number> = ready ? { ready: runnable, total: input.queue.length } : { count: blockingFailures.length };
  return { ready, checkedAt: now, workspaceId: workspace?.id ?? '', summaryKey, summaryParams, checks, counts: { total: input.queue.length, ready: runnable, published, failed, skipped, duplicates: duplicateItems, publishedDuplicates, invalid } };
}
