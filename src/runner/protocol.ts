/**
 * X-Pilot Local Runner — Native Messaging protocol contract (extension side).
 *
 * Mirrors the Chrome Native Messaging wire format:
 * - JSON messages encoded as UTF-8.
 * - Each message is prefixed with a 4-byte length header in the platform's
 *   native byte order. The byte LENGTH of the UTF-8 payload is written, not
 *   the number of characters.
 * - Messages from the host to Chrome are capped at 1 MiB.
 *
 * This module is deliberately free of chrome.* references so it can be unit
 * tested in Node. The Local Runner package keeps a byte-compatible mirror at
 * local-runner/src/protocol.ts (guarded by protocol-sync tests).
 */

export const RUNNER_PROTOCOL_VERSION = 1;
/** Registered native messaging host name. */
export const RUNNER_HOST_NAME = 'com.so7ob.x_pilot_runner';
/** Chrome caps host-to-extension messages at 1 MiB (1_000_000 bytes of payload). */
export const RUNNER_MAX_MESSAGE_BYTES = 1_000_000;
/** Chrome sends at most one message per write; the host may receive arbitrary chunking. */
export const RUNNER_MAX_FRAME_BYTES = 64 * 1024 * 1024;

export type RunnerCommand =
  | 'PING'
  | 'GET_INFO'
  | 'INSPECT'
  | 'PUBLISH'
  | 'GET_OPERATION'
  | 'CANCEL'
  | 'OPEN_LOGIN'
  | 'CLOSE_LOGIN'
  | 'CLEANUP';

export const RUNNER_COMMANDS: readonly RunnerCommand[] = ['PING', 'GET_INFO', 'INSPECT', 'PUBLISH', 'GET_OPERATION', 'CANCEL', 'OPEN_LOGIN', 'CLOSE_LOGIN', 'CLEANUP'];

export type RunnerResponseType = 'ACK' | 'EVENT' | 'RESULT';
export type RunnerResponseStatus = 'OK' | 'DUPLICATE' | 'REJECTED' | 'ERROR';

export type RunnerResultCode =
  | 'RUNNER_OK'
  | 'RUNNER_PROTOCOL_MISMATCH'
  | 'RUNNER_UNKNOWN_COMMAND'
  | 'RUNNER_INVALID_REQUEST'
  | 'RUNNER_NOT_READY'
  | 'RUNNER_PROFILE_LOCKED'
  | 'RUNNER_LOGIN_REQUIRED'
  | 'RUNNER_CHALLENGE'
  | 'RUNNER_ACCOUNT_MISMATCH'
  | 'RUNNER_ACCOUNT_UNKNOWN'
  | 'RUNNER_CONTENT_MISMATCH'
  | 'RUNNER_DAILY_LIMIT'
  | 'RUNNER_PUBLISH_REJECTED'
  | 'RUNNER_TIMEOUT'
  | 'RUNNER_DUPLICATE_OPERATION'
  | 'RUNNER_OPERATION_CONTENT_MISMATCH'
  | 'RUNNER_OPERATION_NOT_FOUND'
  | 'RUNNER_CANCELLED'
  | 'RUNNER_UNVERIFIED'
  | 'RUNNER_LAUNCH_FAILED'
  | 'RUNNER_BROWSER_CRASHED'
  | 'RUNNER_LOGIN_WINDOW_TIMEOUT'
  | 'RUNNER_LOGIN_NOT_PERSISTED'
  | 'RUNNER_LOGIN_WINDOW_BUSY'
  | 'RUNNER_ERROR';

export interface RunnerRequest {
  protocolVersion: number;
  requestId: string;
  command: RunnerCommand;
  workspaceId: string;
  profileId: string;
  operationId?: string;
  payload?: Record<string, unknown>;
  issuedAt: number;
}

export interface RunnerResponse {
  protocolVersion: number;
  requestId: string;
  type: RunnerResponseType;
  status: RunnerResponseStatus;
  code?: RunnerResultCode;
  message?: string;
  result?: Record<string, unknown>;
  at: number;
}

export interface RunnerInfo {
  runnerVersion: string;
  protocolVersion: number;
  capabilities: string[];
  nodeVersion: string;
  platform: string;
  profiles: Array<{ profileId: string; hasSession: boolean; account?: string; lastVerifiedAt?: number }>;
  activeOperations: number;
}

/** Page-level inspection result (no publishing side effects). */
export interface RunnerInspection {
  pageKind: 'X' | 'LOGIN' | 'CHALLENGE' | 'ERROR' | 'UNKNOWN';
  composerFound: boolean;
  contentPresent: boolean;
  contentMatches: boolean;
  postButtonFound: boolean;
  postButtonEnabled: boolean;
  detectedAccount?: string;
  dailyPostLimitReached: boolean;
  reason?: string;
  checkedAt: number;
}

export type RunnerPublishOutcome = 'CONFIRMED' | 'UNVERIFIED' | 'FAILED_BEFORE_SUBMIT' | 'REJECTED';

export interface RunnerPublishResult {
  outcome: RunnerPublishOutcome;
  postUrl?: string;
  detectedAccount?: string;
  reason?: string;
  /** Attempt-scoped evidence backing the outcome. */
  evidence?: {
    createTweetResponseStatus?: number;
    createTweetResponseUrl?: string;
    tweetId?: string;
    composerCleared?: boolean;
    confirmationToast?: boolean;
    newStatusLink?: string;
    submittedAt?: number;
    completedAt?: number;
  };
  recordedOutcome?: RunnerPublishOutcome;
  duplicateOfLedger?: boolean;
}

export type RunnerOperationStatus = 'RECEIVED' | 'STARTED' | 'SUBMITTED' | 'CONFIRMED' | 'UNVERIFIED' | 'FAILED_BEFORE_SUBMIT' | 'REJECTED' | 'CANCELLED';

export interface RunnerOperationRecord {
  operationId: string;
  workspaceId: string;
  profileId: string;
  targetUrl: string;
  contentHash: string;
  expectedAccount?: string;
  status: RunnerOperationStatus;
  result?: RunnerPublishResult;
  createdAt: number;
  updatedAt: number;
  submittedAt?: number;
  completedAt?: number;
}

export interface RunnerEventPayload {
  event: 'LOG' | 'LOGIN_WINDOW_OPENED' | 'LOGIN_WINDOW_CLOSED' | 'OPERATION_PROGRESS' | 'RUNNER_SHUTDOWN';
  level?: 'debug' | 'info' | 'warn' | 'error';
  message?: string;
  detail?: Record<string, unknown>;
}

/** Payload validation helpers (shared by bridge and tests). */

export function isValidRunnerRequest(value: unknown): value is RunnerRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as Partial<RunnerRequest>;
  if (typeof request.protocolVersion !== 'number' || !Number.isFinite(request.protocolVersion)) return false;
  if (typeof request.requestId !== 'string' || !request.requestId || request.requestId.length > 128) return false;
  if (!RUNNER_COMMANDS.includes(request.command as RunnerCommand)) return false;
  if (typeof request.workspaceId !== 'string' || request.workspaceId.length > 128) return false;
  if (typeof request.profileId !== 'string' || request.profileId.length > 128) return false;
  if (request.operationId !== undefined && (typeof request.operationId !== 'string' || request.operationId.length > 128)) return false;
  if (request.payload !== undefined && (typeof request.payload !== 'object' || request.payload === null || Array.isArray(request.payload))) return false;
  if (typeof request.issuedAt !== 'number' || !Number.isFinite(request.issuedAt)) return false;
  return true;
}

/**
 * Byte-level framing used by the Local Runner side of the protocol (and by
 * protocol tests on both sides). Chrome itself performs this framing for the
 * extension; the runner reads/writes raw stdin/stdout bytes.
 */
export type Endianness = 'LE' | 'BE';

export function encodeFrame(payload: string, endianness: Endianness = 'LE', maxBytes = RUNNER_MAX_MESSAGE_BYTES): Uint8Array {
  const body = new TextEncoder().encode(payload);
  if (body.byteLength > maxBytes) throw new Error(`RUNNER_MESSAGE_TOO_LARGE:${body.byteLength}`);
  const frame = new Uint8Array(4 + body.byteLength);
  const view = new DataView(frame.buffer);
  if (endianness === 'LE') view.setUint32(0, body.byteLength, true);
  else view.setUint32(0, body.byteLength, false);
  frame.set(body, 4);
  return frame;
}

/**
 * Incremental frame decoder: accepts arbitrary chunk boundaries (fragmented or
 * coalesced messages) and returns every complete JSON payload found.
 */
export class FrameDecoder {
  private buffer: Uint8Array = new Uint8Array(0);
  private readonly endianness: Endianness;
  private readonly maxFrameBytes: number;
  constructor(endianness: Endianness = 'LE', maxFrameBytes = RUNNER_MAX_FRAME_BYTES) {
    this.endianness = endianness;
    this.maxFrameBytes = maxFrameBytes;
  }

  push(chunk: Uint8Array): string[] {
    const merged = new Uint8Array(this.buffer.byteLength + chunk.byteLength);
    merged.set(this.buffer, 0);
    merged.set(chunk, this.buffer.byteLength);
    this.buffer = merged;
    const payloads: string[] = [];
    for (;;) {
      if (this.buffer.byteLength < 4) break;
      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
      const length = this.endianness === 'LE' ? view.getUint32(0, true) : view.getUint32(0, false);
      if (length > this.maxFrameBytes) { this.buffer = new Uint8Array(0); throw new Error(`RUNNER_FRAME_TOO_LARGE:${length}`); }
      if (this.buffer.byteLength < 4 + length) break;
      const body = this.buffer.subarray(4, 4 + length);
      payloads.push(new TextDecoder().decode(body));
      this.buffer = this.buffer.subarray(4 + length);
    }
    return payloads;
  }
}
