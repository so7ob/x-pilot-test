/**
 * Command dispatcher: the ONLY place runner commands are interpreted.
 *
 * Security posture:
 * - Commands are an explicit allowlist (RUNNER_COMMANDS). There is no channel
 *   for arbitrary JavaScript, shell commands, or reading files chosen by the
 *   message sender.
 * - Every request is schema-validated (isValidRunnerRequest) and
 *   protocol-version-checked before dispatch.
 * - The ledger enforces publish idempotency BEFORE any browser work starts.
 * - Cancellation is cooperative: effective only before the submit click;
 *   afterwards the operation settles through the ledger.
 */

import type { Page, Response } from 'playwright';
import type { RunnerCommand, RunnerInspection, RunnerOperationRecord, RunnerPublishResult, RunnerRequest, RunnerResponse, RunnerResultCode } from './protocol.ts';
import { RUNNER_COMMANDS, RUNNER_PROTOCOL_VERSION, type RunnerInfo } from './protocol.ts';
import { OperationLedger, type OperationKey } from './ledger.ts';
import { BrowserManager } from './browser.ts';
import { XFlow } from './x-flow.ts';
import { listProfiles } from './profile-store.ts';
import { RunnerLogger } from './logging.ts';

const LOGIN_WINDOW_TIMEOUT_MS = 10 * 60 * 1000;
const LOGIN_STABLE_MS = 5_000;

export interface DispatcherOptions {
  ledger: OperationLedger;
  browsers: BrowserManager;
  xFlow: XFlow;
  runnerVersion: string;
  logger?: RunnerLogger;
  emit: (response: RunnerResponse) => void;
  now?: () => number;
}

interface ActiveOperation { cancelled: boolean; profileId: string; startedAt: number; }

function outcomeForLedgerStatus(record: RunnerOperationRecord): RunnerPublishResult {
  if (record.result) return { ...record.result, recordedOutcome: record.result.outcome, duplicateOfLedger: true };
  // In-flight record without a result yet: report its current status.
  const outcome = record.status === 'CONFIRMED' ? 'CONFIRMED' : record.status === 'UNVERIFIED' ? 'UNVERIFIED' : record.status === 'REJECTED' ? 'REJECTED' : 'FAILED_BEFORE_SUBMIT';
  return { outcome, reason: `RUNNER_LEDGER_STATUS:${record.status}`, duplicateOfLedger: true, recordedOutcome: outcome };
}

export class CommandDispatcher {
  private readonly activeOperations = new Map<string, ActiveOperation>();
  private readonly accountCache = new Map<string, { account?: string; verifiedAt: number }>();
  private readonly loginWatchers = new Set<string>();
  private readonly options: DispatcherOptions;

  constructor(options: DispatcherOptions) {
    this.options = options;
  }

  private ok(request: RunnerRequest, result: Record<string, unknown>, status: RunnerResponse['status'] = 'OK', code: RunnerResultCode = 'RUNNER_OK'): RunnerResponse {
    return { protocolVersion: RUNNER_PROTOCOL_VERSION, requestId: request.requestId, type: 'RESULT', status, code, result, at: (this.options.now ?? Date.now)() };
  }

  private error(request: RunnerRequest, code: RunnerResultCode, message: string): RunnerResponse {
    return { protocolVersion: RUNNER_PROTOCOL_VERSION, requestId: request.requestId, type: 'RESULT', status: 'ERROR', code, message, at: (this.options.now ?? Date.now)() };
  }

  private event(payload: Record<string, unknown>): void {
    this.options.emit({ protocolVersion: RUNNER_PROTOCOL_VERSION, requestId: `event-${(this.options.now ?? Date.now)()}-${Math.random().toString(36).slice(2, 8)}`, type: 'EVENT', status: 'OK', code: 'RUNNER_OK', result: payload, at: (this.options.now ?? Date.now)() });
  }

  async dispatch(request: RunnerRequest): Promise<RunnerResponse> {
    if (request.protocolVersion !== RUNNER_PROTOCOL_VERSION) return this.error(request, 'RUNNER_PROTOCOL_MISMATCH', `extension=${request.protocolVersion} runner=${RUNNER_PROTOCOL_VERSION}`);
    if (!RUNNER_COMMANDS.includes(request.command)) return this.error(request, 'RUNNER_UNKNOWN_COMMAND', request.command);
    switch (request.command) {
      case 'PING': return this.ok(request, { pong: true, at: (this.options.now ?? Date.now)() });
      case 'GET_INFO': return this.getInfo(request);
      case 'INSPECT': return this.inspect(request);
      case 'PUBLISH': return this.publish(request);
      case 'GET_OPERATION': return this.getOperation(request);
      case 'CANCEL': return this.cancel(request);
      case 'OPEN_LOGIN': return this.openLogin(request);
      case 'CLOSE_LOGIN': return this.closeLogin(request);
      case 'CLEANUP': return this.cleanup(request);
      default: return this.error(request, 'RUNNER_UNKNOWN_COMMAND', String(request.command satisfies RunnerCommand));
    }
  }

  private readPayload(request: RunnerRequest): Record<string, unknown> {
    return request.payload ?? {};
  }

  private requireTargetUrl(request: RunnerRequest): string {
    const targetUrl = this.readPayload(request).targetUrl;
    if (typeof targetUrl !== 'string' || !/^https?:\/\//i.test(targetUrl)) throw new Error('RUNNER_INVALID_TARGET_URL');
    return targetUrl;
  }

  private operationKey(request: RunnerRequest, targetUrl: string): OperationKey {
    const payload = this.readPayload(request);
    return {
      workspaceId: request.workspaceId,
      profileId: request.profileId,
      targetUrl,
      expectedContent: typeof payload.expectedContent === 'string' ? payload.expectedContent : undefined,
      expectedAccount: typeof payload.expectedAccount === 'string' ? payload.expectedAccount : undefined,
    };
  }

  private async getInfo(request: RunnerRequest): Promise<RunnerResponse> {
    const info: RunnerInfo = {
      runnerVersion: this.options.runnerVersion,
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      capabilities: ['PING', 'INSPECT', 'PUBLISH', 'GET_OPERATION', 'CANCEL', 'OPEN_LOGIN', 'CLOSE_LOGIN', 'CLEANUP', 'LEDGER'],
      nodeVersion: process.version,
      platform: `${process.platform}/${process.arch}`,
      profiles: listProfiles().map((profile) => {
        const cached = this.accountCache.get(profile.profileId);
        return { ...profile, account: cached?.account, lastVerifiedAt: cached?.verifiedAt };
      }),
      activeOperations: this.activeOperations.size,
    };
    return this.ok(request, info as unknown as Record<string, unknown>);
  }

  private async inspect(request: RunnerRequest): Promise<RunnerResponse> {
    // INSPECT never reaches the publish flow — structural isolation from the
    // submit click (verified by integration tests).
    const targetUrl = this.requireTargetUrl(request);
    const payload = this.readPayload(request);
    const expectedAccount = typeof payload.expectedAccount === 'string' ? payload.expectedAccount : undefined;
    const expectedContent = typeof payload.expectedContent === 'string' ? payload.expectedContent : undefined;
    const active = this.activeOperations.get(request.operationId ?? '');
    if (active?.cancelled) return this.error(request, 'RUNNER_CANCELLED', 'cancelled before dispatch');
    const context = await this.options.browsers.openContext(request.profileId, { headless: true });
    this.options.browsers.touch(request.profileId);
    const page = await context.newPage();
    try {
      const inspection: RunnerInspection = await this.options.xFlow.inspectTarget(page, targetUrl, { expectedAccount, expectedContent });
      if (inspection.detectedAccount) this.accountCache.set(request.profileId, { account: inspection.detectedAccount, verifiedAt: Date.now() });
      return this.ok(request, inspection as unknown as Record<string, unknown>);
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  private async publish(request: RunnerRequest): Promise<RunnerResponse> {
    if (!request.operationId) return this.error(request, 'RUNNER_INVALID_REQUEST', 'operationId is required for PUBLISH');
    const targetUrl = this.requireTargetUrl(request);
    const key = this.operationKey(request, targetUrl);

    // 1) Idempotency gate — BEFORE any browser work.
    const existing = this.options.ledger.lookup(request.operationId);
    if (existing) {
      if (!this.options.ledger.matches(existing, key)) {
        return this.error(request, 'RUNNER_OPERATION_CONTENT_MISMATCH', 'same operationId submitted with different content binding');
      }
      // Duplicate delivery of a known operation: return the recorded outcome,
      // never execute again.
      const result = outcomeForLedgerStatus(existing);
      return { protocolVersion: RUNNER_PROTOCOL_VERSION, requestId: request.requestId, type: 'RESULT', status: 'DUPLICATE', code: 'RUNNER_DUPLICATE_OPERATION', result: result as unknown as Record<string, unknown>, at: (this.options.now ?? Date.now)() };
    }

    // 2) Durable receipt (fsync'd) before starting.
    await this.options.ledger.recordReceived(request.operationId, key);
    if (this.activeOperations.has(request.operationId)) return this.error(request, 'RUNNER_NOT_READY', 'operation already executing');
    const active: ActiveOperation = { cancelled: false, profileId: request.profileId, startedAt: Date.now() };
    this.activeOperations.set(request.operationId, active);
    try {
      const context = await this.options.browsers.openContext(request.profileId, { headless: true });
      this.options.browsers.touch(request.profileId);
      const page = await context.newPage();
      try {
        const result = await this.options.xFlow.publishTarget(page, targetUrl, { expectedAccount: key.expectedAccount, expectedContent: key.expectedContent }, async () => {
          if (active.cancelled) throw new Error('RUNNER_CANCELLED');
          // markStarted then the fsync'd SUBMITTED write immediately before
          // the irreversible click.
          await this.options.ledger.markStarted(request.operationId!);
          await this.options.ledger.markSubmitted(request.operationId!);
          if (active.cancelled) throw new Error('RUNNER_CANCELLED');
        });
        if (result.detectedAccount) this.accountCache.set(request.profileId, { account: result.detectedAccount, verifiedAt: Date.now() });
        const ledgerStatus = result.outcome === 'CONFIRMED' ? 'CONFIRMED' : result.outcome === 'UNVERIFIED' ? 'UNVERIFIED' : result.outcome === 'REJECTED' ? 'REJECTED' : 'FAILED_BEFORE_SUBMIT';
        await this.options.ledger.complete(request.operationId, ledgerStatus, result);
        return this.ok(request, result as unknown as Record<string, unknown>);
      } finally {
        await page.close().catch(() => undefined);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === 'RUNNER_CANCELLED') {
        await this.options.ledger.markCancelled(request.operationId).catch(() => undefined);
        return this.error(request, 'RUNNER_CANCELLED', 'operation cancelled before submit');
      }
      // Ledger record stays RECEIVED/STARTED (pre-submit proven) or SUBMITTED
      // (uncertain). Either way the extension reconciles conservatively.
      (this.options.logger ?? new RunnerLogger()).error('publish command failed', { operationId: request.operationId, message });
      return this.error(request, 'RUNNER_ERROR', message);
    } finally {
      this.activeOperations.delete(request.operationId);
    }
  }

  private async getOperation(request: RunnerRequest): Promise<RunnerResponse> {
    if (!request.operationId) return this.error(request, 'RUNNER_INVALID_REQUEST', 'operationId is required for GET_OPERATION');
    const record = this.options.ledger.lookup(request.operationId);
    if (!record) return this.error(request, 'RUNNER_OPERATION_NOT_FOUND', request.operationId);
    return this.ok(request, { record: record as unknown as Record<string, unknown> });
  }

  private async cancel(request: RunnerRequest): Promise<RunnerResponse> {
    if (!request.operationId) return this.error(request, 'RUNNER_INVALID_REQUEST', 'operationId is required for CANCEL');
    const active = this.activeOperations.get(request.operationId);
    if (!active) {
      const record = this.options.ledger.lookup(request.operationId);
      return this.ok(request, { cancelled: false, status: record?.status ?? 'UNKNOWN', note: 'no in-flight operation' });
    }
    if (recordIsSubmitted(this.options.ledger.lookup(request.operationId))) {
      // The submit may already have reached X: never claim cancellation.
      return this.ok(request, { cancelled: false, status: 'SUBMITTED', note: 'submit already dispatched; outcome will settle via ledger' });
    }
    active.cancelled = true;
    return this.ok(request, { cancelled: true, status: 'CANCELLING', note: 'cancellation requested before submit' });
  }

  private async openLogin(request: RunnerRequest): Promise<RunnerResponse> {
    // Explicit user action only: the ONLY visible window X-Pilot ever opens.
    if (this.options.browsers.isLoginWindowOpen(request.profileId)) return this.error(request, 'RUNNER_LOGIN_WINDOW_BUSY', 'login window already open for this profile');
    if (this.loginWatchers.has(request.profileId)) return this.error(request, 'RUNNER_LOGIN_WINDOW_BUSY', 'login setup already in progress');
    try {
      const context = await this.options.browsers.openContext(request.profileId, { headless: false });
      const page = await context.newPage();
      await page.goto(this.loginStartUrl(), { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => undefined);
      this.event({ event: 'LOGIN_WINDOW_OPENED', profileId: request.profileId, workspaceId: request.workspaceId });
      this.loginWatchers.add(request.profileId);
      void this.watchLogin(request, page).catch(() => undefined);
      return this.ok(request, { opened: true, loginWindowOpen: true, note: 'login window opened; completion is reported via LOGIN_WINDOW_CLOSED event and GET_INFO' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = message.includes('RUNNER_PROFILE_LOCKED') ? 'RUNNER_PROFILE_LOCKED' : message.includes('RUNNER_LAUNCH_FAILED') ? 'RUNNER_LAUNCH_FAILED' : 'RUNNER_ERROR';
      return this.error(request, code as RunnerResultCode, message);
    }
  }

  private loginStartUrl(): string {
    return `${this.options.xFlow.baseUrl}/login`;
  }

  private async watchLogin(request: RunnerRequest, page: Page): Promise<void> {
    const deadline = Date.now() + LOGIN_WINDOW_TIMEOUT_MS;
    let lastAccountSeenAt = 0;
    let account: string | undefined;
    try {
      while (Date.now() < deadline) {
        await page.waitForTimeout(2000);
        if (page.isClosed()) break;
        try {
          const href = await page.evaluate((selectors: string[]) => {
            for (const selector of selectors) {
              const anchor = document.querySelector<HTMLAnchorElement>(selector);
              const found = anchor?.getAttribute('href');
              if (found) return found;
            }
            return null;
          }, ['a[data-testid="AppTabBar_Profile_Link"]']);
          if (href) {
            const handle = href.match(/^\/(?:i\/)?([A-Za-z0-9_]{1,15})(?:\/|$|\?)/)?.[1];
            if (handle && !['home', 'i', 'explore', 'notifications', 'messages'].includes(handle.toLowerCase())) {
              if (account === handle) {
                if (Date.now() - lastAccountSeenAt >= LOGIN_STABLE_MS) break;
              } else {
                account = handle;
                lastAccountSeenAt = Date.now();
              }
            } else {
              account = undefined;
            }
          } else {
            account = undefined;
          }
        } catch { /* page navigating */ }
      }
      // Close the visible window cleanly.
      await this.options.browsers.closeContext(request.profileId);
      if (!account) {
        this.event({ event: 'LOGIN_WINDOW_CLOSED', profileId: request.profileId, workspaceId: request.workspaceId, outcome: account ? 'OK' : 'RUNNER_LOGIN_WINDOW_TIMEOUT' });
        this.loginWatchers.delete(request.profileId);
        return;
      }
      // Reopen the SAME profile headless and verify the session persisted.
      let persisted = false;
      let verifiedAccount: string | undefined;
      try {
        const context = await this.options.browsers.openContext(request.profileId, { headless: true });
        const verifyPage = await context.newPage();
        const detected = await this.options.xFlow.detectAccount(verifyPage);
        persisted = detected.pageKind === 'X' && Boolean(detected.account);
        verifiedAccount = detected.account;
        await verifyPage.close().catch(() => undefined);
      } catch { persisted = false; }
      if (persisted && verifiedAccount) this.accountCache.set(request.profileId, { account: verifiedAccount, verifiedAt: Date.now() });
      this.event({
        event: 'LOGIN_WINDOW_CLOSED',
        profileId: request.profileId,
        workspaceId: request.workspaceId,
        outcome: persisted ? 'OK' : 'RUNNER_LOGIN_NOT_PERSISTED',
        account: verifiedAccount,
        persisted,
      });
    } finally {
      this.loginWatchers.delete(request.profileId);
    }
  }

  private async closeLogin(request: RunnerRequest): Promise<RunnerResponse> {
    const closed = await this.options.browsers.closeLoginWindow(request.profileId);
    this.event({ event: 'LOGIN_WINDOW_CLOSED', profileId: request.profileId, workspaceId: request.workspaceId, outcome: 'CLOSED_BY_USER' });
    return this.ok(request, { closed });
  }

  private async cleanup(request: RunnerRequest): Promise<RunnerResponse> {
    // Cleanup closes browser contexts the runner owns; it NEVER touches the
    // duplicate-prevention ledger.
    await this.options.browsers.closeAll();
    return this.ok(request, { cleaned: true, ledgerRecords: this.options.ledger.list().length });
  }
}

function recordIsSubmitted(record: RunnerOperationRecord | undefined): boolean {
  return record?.status === 'SUBMITTED' || record?.status === 'CONFIRMED' || record?.status === 'UNVERIFIED' || record?.status === 'REJECTED';
}
