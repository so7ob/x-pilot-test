import type { RunnerInfo, RunnerInspection, RunnerOperationRecord, RunnerPublishResult, RunnerRequest, RunnerResponse, RunnerResultCode } from './protocol.ts';
import { RUNNER_COMMANDS, RUNNER_HOST_NAME, RUNNER_PROTOCOL_VERSION, type RunnerCommand } from './protocol.ts';
import type { RunnerStatusSummary } from '../domain/models';

/**
 * X-Pilot Local Runner bridge (Service Worker side).
 *
 * Speaks Native Messaging with the registered host `com.so7ob.x_pilot_runner`
 * through chrome.runtime.connectNative. Responsibilities:
 * - single long-lived port with bounded reconnect attempts,
 * - request/response correlation by requestId + per-command timeouts,
 * - protocol version handshake (PROTOCOL_MISMATCH is reported, never guessed),
 * - cached runner status for the UI (no I/O on the hot polling path),
 * - bounded reconnect that NEVER re-sends a publish command implicitly:
 *   in-flight PUBLISH requests fail with RUNNER_DISCONNECTED and the engine's
 *   conservative PUBLISHED_UNVERIFIED path takes over; lost operations are
 *   settled explicitly via GET_OPERATION reconciliation.
 *
 * The port factory is injectable so the bridge is unit-testable in Node with a
 * fake chrome.runtime port.
 */

const COMMAND_TIMEOUT_MS: Record<RunnerCommand, number> = {
  PING: 8_000,
  GET_INFO: 12_000,
  INSPECT: 120_000,
  PUBLISH: 240_000,
  GET_OPERATION: 12_000,
  CANCEL: 20_000,
  OPEN_LOGIN: 20_000,
  CLOSE_LOGIN: 20_000,
  CLEANUP: 30_000,
};

export interface NativePort {
  postMessage(message: unknown): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
  name?: string;
}

export type PortFactory = (hostName: string) => NativePort;

const defaultPortFactory: PortFactory = (hostName) => chrome.runtime.connectNative(hostName) as unknown as NativePort;

interface PendingRequest {
  resolve: (response: RunnerResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  command: RunnerCommand;
}

interface BridgeState {
  port: NativePort | null;
  pending: Map<string, PendingRequest>;
  eventListeners: Set<(response: RunnerResponse) => void>;
  state: RunnerStatusSummary;
  reconnectAttempts: number;
  lastDisconnectAt: number;
  info: RunnerInfo | null;
}

function initialState(): BridgeState {
  return {
    port: null,
    pending: new Map(),
    eventListeners: new Set(),
    state: { state: 'UNKNOWN', connected: false, lastCheckedAt: 0 },
    reconnectAttempts: 0,
    lastDisconnectAt: 0,
    info: null,
  };
}

const RECONNECT_MAX_ATTEMPTS = 3;
const RECONNECT_BACKOFF_MS = 600;

let bridgeState: BridgeState = initialState();

function describeState(): RunnerStatusSummary {
  const summary: RunnerStatusSummary = { ...bridgeState.state, lastCheckedAt: bridgeState.state.lastCheckedAt ?? Date.now() };
  if (bridgeState.info) {
    summary.runnerVersion = bridgeState.info.runnerVersion;
    summary.protocolVersion = bridgeState.info.protocolVersion;
    summary.protocolCompatible = bridgeState.info.protocolVersion === RUNNER_PROTOCOL_VERSION;
    if (summary.protocolCompatible === false) summary.state = 'PROTOCOL_MISMATCH';
  }
  return summary;
}

function setState(next: Partial<RunnerStatusSummary>): void {
  bridgeState.state = { ...bridgeState.state, ...next };
}

function failPending(error: Error): void {
  for (const [requestId, pending] of bridgeState.pending) {
    clearTimeout(pending.timer);
    bridgeState.pending.delete(requestId);
    pending.reject(error);
  }
}

function noteDisconnect(errorCode: string): void {
  bridgeState.port = null;
  bridgeState.lastDisconnectAt = Date.now();
  bridgeState.reconnectAttempts += 1;
  setState({ connected: false, state: mapDisconnectState(errorCode), lastErrorCode: errorCode, lastErrorAt: Date.now() });
  failPending(new Error(errorCode));
}

function mapDisconnectState(errorCode: string): RunnerStatusSummary['state'] {
  // Chrome reports "not installed" and launch failures through lastError on the port.
  if (errorCode === 'not-installed' || errorCode.includes('not found') || errorCode.includes('NOT_INSTALLED')) return 'NOT_INSTALLED';
  if (errorCode.includes('launch') || errorCode.includes('failed to start') || errorCode.includes('LAUNCH')) return 'LAUNCH_FAILED';
  return 'DISCONNECTED';
}

function attachPort(port: NativePort): void {
  bridgeState.port = port;
  port.onMessage.addListener((message) => handleIncoming(message));
  port.onDisconnect.addListener(() => {
    const error = (chrome.runtime.lastError?.message as string | undefined) ?? 'RUNNER_DISCONNECTED';
    noteDisconnect(error);
  });
}

function handleIncoming(message: unknown): void {
  const response = message as Partial<RunnerResponse> | null;
  if (!response || typeof response !== 'object' || typeof response.requestId !== 'string' || typeof response.type !== 'string') return;
  const typed = response as RunnerResponse;
  if (typed.type === 'EVENT') {
    bridgeState.eventListeners.forEach((listener) => listener(typed));
    return;
  }
  const pending = bridgeState.pending.get(typed.requestId);
  if (!pending) return;
  if (typed.type === 'RESULT') {
    clearTimeout(pending.timer);
    bridgeState.pending.delete(typed.requestId);
    if (typed.code === 'RUNNER_PROTOCOL_MISMATCH') setState({ state: 'PROTOCOL_MISMATCH', lastErrorCode: typed.code, lastErrorAt: Date.now() });
    if (typed.code === 'RUNNER_OK' && pending.command === 'GET_INFO') {
      bridgeState.info = typed.result as unknown as RunnerInfo;
      setState({ connected: true, state: 'CONNECTED', lastErrorCode: undefined });
    }
    pending.resolve(typed);
    return;
  }
  if (typed.type === 'ACK') {
    // Receipt of the request by the host; keep waiting for RESULT.
    if (typed.code && typed.code !== 'RUNNER_OK') {
      clearTimeout(pending.timer);
      bridgeState.pending.delete(typed.requestId);
      pending.resolve(typed);
    }
    return;
  }
}

async function ensurePort(hostName = RUNNER_HOST_NAME, factory: PortFactory = defaultPortFactory): Promise<NativePort> {
  if (bridgeState.port) return bridgeState.port;
  if (bridgeState.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS && Date.now() - bridgeState.lastDisconnectAt < 30_000) {
    throw new Error('RUNNER_CONNECT_EXHAUSTED');
  }
  try {
    const port = factory(hostName);
    attachPort(port);
    bridgeState.reconnectAttempts = 0;
    setState({ connected: true, state: 'CONNECTED' });
    return port;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'RUNNER_LAUNCH_FAILED';
    setState({ connected: false, state: 'LAUNCH_FAILED', lastErrorCode: message, lastErrorAt: Date.now() });
    throw new Error('RUNNER_LAUNCH_FAILED');
  }
}

async function request(command: RunnerCommand, options: { workspaceId: string; profileId: string; operationId?: string; payload?: Record<string, unknown>; timeoutMs?: number; hostName?: string; factory?: PortFactory }): Promise<RunnerResponse> {
  if (!RUNNER_COMMANDS.includes(command)) throw new Error('RUNNER_UNKNOWN_COMMAND');
  const port = await ensurePort(options.hostName, options.factory);
  const requestId = crypto.randomUUID();
  const requestEnvelope: RunnerRequest = {
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    requestId,
    command,
    workspaceId: options.workspaceId,
    profileId: options.profileId,
    operationId: options.operationId,
    payload: options.payload,
    issuedAt: Date.now(),
  };
  const timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS[command];
  return new Promise<RunnerResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      bridgeState.pending.delete(requestId);
      reject(new Error('RUNNER_TIMEOUT'));
    }, timeoutMs);
    bridgeState.pending.set(requestId, { resolve, reject, timer, command });
    try {
      port.postMessage(requestEnvelope);
    } catch (error) {
      clearTimeout(timer);
      bridgeState.pending.delete(requestId);
      reject(new Error('RUNNER_DISCONNECTED'));
    }
  });
}

export const localRunnerBridge = {
  /** Sends PING + GET_INFO and returns the runner info; updates cached status. */
  async testConnection(workspaceId = 'x-pilot-global', profileId = 'x-pilot-global', factory?: PortFactory): Promise<{ ok: boolean; info?: RunnerInfo; code?: RunnerResultCode; message?: string }> {
    try {
      const ping = await request('PING', { workspaceId, profileId, factory });
      if (ping.code && ping.code !== 'RUNNER_OK') return { ok: false, code: ping.code, message: ping.message };
      const info = await request('GET_INFO', { workspaceId, profileId, factory });
      if (info.code === 'RUNNER_OK') {
        bridgeState.info = info.result as unknown as RunnerInfo;
        const compatible = bridgeState.info.protocolVersion === RUNNER_PROTOCOL_VERSION;
        setState({ connected: true, state: compatible ? 'CONNECTED' : 'PROTOCOL_MISMATCH', protocolVersion: bridgeState.info.protocolVersion, protocolCompatible: compatible, runnerVersion: bridgeState.info.runnerVersion, lastErrorCode: undefined, lastCheckedAt: Date.now() });
        return { ok: compatible, info: bridgeState.info, code: compatible ? undefined : 'RUNNER_PROTOCOL_MISMATCH' };
      }
      setState({ connected: false, state: info.code === 'RUNNER_PROTOCOL_MISMATCH' ? 'PROTOCOL_MISMATCH' : 'DISCONNECTED', lastErrorCode: info.code, lastErrorAt: Date.now(), lastCheckedAt: Date.now() });
      return { ok: false, code: info.code, message: info.message };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'RUNNER_ERROR';
      setState({ connected: false, state: message === 'RUNNER_LAUNCH_FAILED' ? 'LAUNCH_FAILED' : 'DISCONNECTED', lastErrorCode: message, lastErrorAt: Date.now(), lastCheckedAt: Date.now() });
      return { ok: false, message };
    }
  },

  /** Cached status for UI polling; performs no native I/O. */
  describe(): RunnerStatusSummary {
    return describeState();
  },

  onEvent(listener: (response: RunnerResponse) => void): () => void {
    bridgeState.eventListeners.add(listener);
    return () => bridgeState.eventListeners.delete(listener);
  },

  async inspect(options: { workspaceId: string; profileId: string; targetUrl: string; expectedAccount?: string; expectedContentHash?: string; expectedContent?: string; factory?: PortFactory }): Promise<RunnerInspection> {
    const response = await request('INSPECT', {
      workspaceId: options.workspaceId,
      profileId: options.profileId,
      factory: options.factory,
      payload: { targetUrl: options.targetUrl, expectedAccount: options.expectedAccount, expectedContentHash: options.expectedContentHash, expectedContent: options.expectedContent },
    });
    if (response.status === 'ERROR' || (response.code && response.code !== 'RUNNER_OK' && response.code !== 'RUNNER_DUPLICATE_OPERATION')) throw new Error(response.code ?? 'RUNNER_ERROR');
    return response.result as unknown as RunnerInspection;
  },

  /**
   * Idempotent publish. The runner ledger keyed by operationId guarantees that
   * a repeated request returns the recorded outcome instead of publishing again.
   */
  async publish(options: { workspaceId: string; profileId: string; operationId: string; targetUrl: string; expectedAccount?: string; expectedContentHash?: string; expectedContent?: string; factory?: PortFactory }): Promise<RunnerPublishResult> {
    const response = await request('PUBLISH', {
      workspaceId: options.workspaceId,
      profileId: options.profileId,
      factory: options.factory,
      operationId: options.operationId,
      payload: { targetUrl: options.targetUrl, expectedAccount: options.expectedAccount, expectedContentHash: options.expectedContentHash, expectedContent: options.expectedContent },
    });
    if (response.status === 'ERROR' || (response.code && response.code !== 'RUNNER_OK' && response.code !== 'RUNNER_DUPLICATE_OPERATION')) throw new Error(response.code ?? 'RUNNER_ERROR');
    return response.result as unknown as RunnerPublishResult;
  },

  /** Queries the durable runner ledger for a previous operation. */
  async getOperation(options: { workspaceId: string; profileId: string; operationId: string; factory?: PortFactory }): Promise<RunnerOperationRecord | null> {
    const response = await request('GET_OPERATION', { workspaceId: options.workspaceId, profileId: options.profileId, operationId: options.operationId, factory: options.factory, timeoutMs: 12_000 });
    if (response.code === 'RUNNER_OPERATION_NOT_FOUND') return null;
    if (response.status === 'ERROR') throw new Error(response.code ?? 'RUNNER_ERROR');
    return (response.result as { record?: RunnerOperationRecord } | undefined)?.record ?? null;
  },

  /** Best-effort cancellation of the in-flight operation (effective only before submit). */
  async cancel(options: { workspaceId: string; profileId: string; operationId: string; factory?: PortFactory }): Promise<RunnerResponse> {
    return request('CANCEL', { workspaceId: options.workspaceId, profileId: options.profileId, operationId: options.operationId, factory: options.factory });
  },

  /** Opens the visible login window for a profile (explicit user action only). */
  async openLoginWindow(options: { workspaceId: string; profileId: string; factory?: PortFactory }): Promise<RunnerResponse> {
    return request('OPEN_LOGIN', { workspaceId: options.workspaceId, profileId: options.profileId, factory: options.factory, timeoutMs: 30_000 });
  },

  async closeLoginWindow(options: { workspaceId: string; profileId: string; factory?: PortFactory }): Promise<RunnerResponse> {
    return request('CLOSE_LOGIN', { workspaceId: options.workspaceId, profileId: options.profileId, factory: options.factory });
  },

  async cleanup(options: { workspaceId: string; profileId?: string; factory?: PortFactory }): Promise<RunnerResponse> {
    return request('CLEANUP', { workspaceId: options.workspaceId, profileId: options.profileId ?? options.workspaceId, factory: options.factory });
  },

  /** Resets the bridge (used by tests and after full runner shutdown events). */
  resetForTest(factory?: PortFactory): void {
    failPending(new Error('RUNNER_RESET'));
    bridgeState = initialState();
    void factory;
  },
};

export type LocalRunnerBridge = typeof localRunnerBridge;
