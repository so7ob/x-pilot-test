import type { RunnerOperationRecord, RunnerOperationStatus } from '../runner/protocol';

/**
 * Pure decision table mapping a durable Local Runner ledger record to the
 * safe Queue-item action after an interruption (Service Worker restart,
 * native host crash, or channel loss).
 *
 * Conservative defaults (from the P0 hardening report) are only relaxed with
 * ledger PROOF:
 * - CONFIRMED → PUBLISHED (evidence recorded).
 * - RECEIVED / STARTED / CANCELLED / FAILED_BEFORE_SUBMIT → PENDING (the
 *   ledger proves the irreversible submit click never happened).
 * - REJECTED → FAILED (X-side refusal recorded).
 * - SUBMITTED / UNVERIFIED / anything unknown → CONSERVATIVE: the item stays
 *   for domain recovery, which quarantines it as PUBLISHED_UNVERIFIED and
 *   NEVER auto-republishes. A lost channel is never treated as publish
 *   failure proof.
 */

export type ReconciliationDecision =
  | { action: 'PUBLISHED'; publishedAt: number; postUrl?: string }
  | { action: 'FAILED'; reason: string }
  | { action: 'PENDING'; reason: string }
  | { action: 'CONSERVATIVE'; status: RunnerOperationStatus };

export function decideRunnerReconciliation(record: RunnerOperationRecord): ReconciliationDecision {
  switch (record.status) {
    case 'CONFIRMED':
      return { action: 'PUBLISHED', publishedAt: record.completedAt ?? record.updatedAt, postUrl: record.result?.postUrl };
    case 'REJECTED':
      return { action: 'FAILED', reason: record.result?.reason ?? 'RUNNER_PUBLISH_REJECTED' };
    case 'RECEIVED':
    case 'STARTED':
    case 'CANCELLED':
    case 'FAILED_BEFORE_SUBMIT':
      // The fsync'd SUBMITTED write happens immediately BEFORE the click, so
      // these statuses prove the click never dispatched.
      return { action: 'PENDING', reason: `RUNNER_INTERRUPTED_PRE_SUBMIT:${record.status}` };
    case 'SUBMITTED':
    case 'UNVERIFIED':
    default:
      return { action: 'CONSERVATIVE', status: record.status };
  }
}
