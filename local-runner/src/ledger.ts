/**
 * Durable operation ledger — the local duplicate-publish guard.
 *
 * Guarantees:
 * - A PUBLISH command is keyed by operationId. Receiving the SAME request
 *   again returns the recorded outcome; it is NEVER executed twice.
 * - The ledger binds each operationId to (workspaceId, profileId, targetUrl,
 *   intended content, expected account). The SAME id with DIFFERENT content is
 *   rejected with RUNNER_OPERATION_CONTENT_MISMATCH.
 * - markSubmitted is an fsync'd durable write executed immediately BEFORE the
 *   irreversible click. A crash after this point leaves SUBMITTED (or a final
 *   state) — never a silently resettable record.
 * - Ordinary resource cleanup NEVER deletes CONFIRMED / UNVERIFIED / SUBMITTED
 *   / REJECTED records; only stale CANCELLED / FAILED_BEFORE_SUBMIT records
 *   are pruned after 30 days.
 * - Writes are atomic (tmp + fsync + rename + dir fsync) and survive both
 *   runner and extension restarts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { RunnerOperationRecord, RunnerOperationStatus, RunnerPublishResult } from './protocol.ts';
import { RunnerLogger } from './logging.ts';

const PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const PRUNABLE_STATUSES: readonly RunnerOperationStatus[] = ['CANCELLED', 'FAILED_BEFORE_SUBMIT'];

export interface OperationKey {
  workspaceId: string;
  profileId: string;
  targetUrl: string;
  expectedContent?: string;
  expectedAccount?: string;
}

export function contentHashFor(key: OperationKey): string {
  return createHash('sha256').update(JSON.stringify({
    workspaceId: key.workspaceId,
    profileId: key.profileId,
    targetUrl: key.targetUrl,
    content: key.expectedContent ?? '',
    account: (key.expectedAccount ?? '').toLowerCase(),
  })).digest('hex');
}

export class OperationLedger {
  private records = new Map<string, RunnerOperationRecord>();
  private readonly file: string;
  private readonly logger: RunnerLogger;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(file: string, logger = new RunnerLogger()) {
    this.file = file;
    this.logger = logger;
  }

  /** Loads (or recovers) the persisted ledger. A corrupt file is preserved as
   * evidence (.corrupt-<ts>) and a fresh ledger starts — the extension keeps
   * its own conservative duplicate guards independently. */
  async load(): Promise<void> {
    try {
      const raw = await fs.promises.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as { records?: RunnerOperationRecord[] } | Record<string, RunnerOperationRecord>;
      const list = Array.isArray(parsed?.records) ? parsed.records : Object.values(parsed ?? {});
      for (const record of list) {
        if (record?.operationId && record.status) this.records.set(record.operationId, record);
      }
      this.logger.info('ledger loaded', { count: this.records.size });
    } catch (error: unknown) {
      const code = (error as { code?: string })?.code;
      if (code === 'ENOENT') { this.logger.info('ledger file absent; starting fresh'); return; }
      // Corrupt ledger: preserve it for inspection, never silently delete.
      const backup = `${this.file}.corrupt-${Date.now()}`;
      try { await fs.promises.rename(this.file, backup); } catch { /* best effort */ }
      this.logger.error('ledger corrupt; preserved and restarted', { backup, error: String(error) });
      this.records = new Map();
    }
  }

  lookup(operationId: string): RunnerOperationRecord | undefined {
    return this.records.get(operationId);
  }

  /** True when the stored record matches the incoming operation binding. */
  matches(record: RunnerOperationRecord, key: OperationKey): boolean {
    return record.workspaceId === key.workspaceId
      && record.profileId === key.profileId
      && record.targetUrl === key.targetUrl
      && record.contentHash === contentHashFor(key);
  }

  async recordReceived(operationId: string, key: OperationKey, now = Date.now()): Promise<RunnerOperationRecord> {
    const record: RunnerOperationRecord = {
      operationId,
      workspaceId: key.workspaceId,
      profileId: key.profileId,
      targetUrl: key.targetUrl,
      contentHash: contentHashFor(key),
      expectedAccount: key.expectedAccount,
      status: 'RECEIVED',
      createdAt: now,
      updatedAt: now,
    };
    await this.persist(record);
    return record;
  }

  async markStarted(operationId: string, now = Date.now()): Promise<void> {
    await this.mutate(operationId, (record) => ({ ...record, status: 'STARTED', updatedAt: now }));
  }

  /** Durable write BEFORE the irreversible submit click. Must complete and
   * fsync before the click is dispatched. */
  async markSubmitted(operationId: string, now = Date.now()): Promise<void> {
    await this.mutate(operationId, (record) => ({ ...record, status: 'SUBMITTED', submittedAt: record.submittedAt ?? now, updatedAt: now }), { forceFsync: true });
  }

  async markCancelled(operationId: string, now = Date.now()): Promise<void> {
    await this.mutate(operationId, (record) => ({ ...record, status: record.status === 'SUBMITTED' || record.status === 'CONFIRMED' || record.status === 'UNVERIFIED' || record.status === 'REJECTED' ? record.status : 'CANCELLED', updatedAt: now }));
  }

  async complete(operationId: string, status: RunnerOperationStatus, result: RunnerPublishResult, now = Date.now()): Promise<void> {
    await this.mutate(operationId, (record) => ({
      ...record,
      status,
      result,
      completedAt: now,
      updatedAt: now,
      submittedAt: record.submittedAt ?? (status === 'CONFIRMED' || status === 'UNVERIFIED' || status === 'REJECTED' ? now : undefined),
    }));
  }

  /** Removes ONLY prunable stale records. Never touches evidence statuses. */
  async prune(now = Date.now()): Promise<number> {
    const stale = [...this.records.values()].filter((record) => PRUNABLE_STATUSES.includes(record.status) && now - record.updatedAt > PRUNE_AFTER_MS);
    for (const record of stale) this.records.delete(record.operationId);
    if (stale.length) await this.flush();
    return stale.length;
  }

  list(): RunnerOperationRecord[] {
    return [...this.records.values()];
  }

  private async mutate(operationId: string, mutator: (record: RunnerOperationRecord) => RunnerOperationRecord, options: { forceFsync?: boolean } = {}): Promise<void> {
    const record = this.records.get(operationId);
    if (!record) throw new Error(`LEDGER_RECORD_NOT_FOUND:${operationId}`);
    await this.persist(mutator(record), options);
  }

  private persist(record: RunnerOperationRecord, options: { forceFsync?: boolean } = {}): Promise<void> {
    this.records.set(record.operationId, record);
    const run = async () => { await this.flush(options.forceFsync === true); };
    this.writeQueue = this.writeQueue.then(run, run);
    return this.writeQueue;
  }

  /** Atomic durable write: tmp file + fsync + rename + directory fsync. */
  private async flush(fsync = false): Promise<void> {
    const payload = JSON.stringify({ version: 1, records: this.list() });
    const tmp = `${this.file}.tmp`;
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
    const handle = await fs.promises.open(tmp, 'w');
    try {
      await handle.writeFile(payload, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.promises.rename(tmp, this.file);
    } catch {
      // Windows rename-over-existing: retry after unlink.
      try { await fs.promises.unlink(this.file); } catch { /* ignore */ }
      await fs.promises.rename(tmp, this.file);
    }
    if (fsync) {
      try {
        const dirHandle = await fs.promises.open(path.dirname(this.file), 'r');
        await dirHandle.sync();
        await dirHandle.close();
      } catch { /* directory fsync is best-effort on some platforms */ }
    }
  }
}
