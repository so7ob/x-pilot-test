/**
 * X-Pilot Local Runner — protocol contract (runner side).
 *
 * BYTE-COMPATIBLE MIRROR of the extension-side contract at
 * ../src/runner/protocol.ts. Kept in sync by tests/protocol-sync.test.mjs
 * (both suites assert identical constants and command lists).
 *
 * Wire format (Chrome Native Messaging):
 * - UTF-8 JSON payloads.
 * - 4-byte length prefix in the platform's native byte order (see
 *   os.endianness(); every platform Chrome supports today is LE).
 * - The length counts UTF-8 BYTES, not characters.
 * - Host→Chrome messages are capped at 1 MiB.
 */

export const RUNNER_PROTOCOL_VERSION = 1;
export const RUNNER_HOST_NAME = 'com.so7ob.x_pilot_runner';
export const RUNNER_MAX_MESSAGE_BYTES = 1_000_000;
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
