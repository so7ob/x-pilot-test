/**
 * Runner profile store: per-profile Playwright user-data directories OUTSIDE
 * the repository, under the user's app-data folder, plus a PID-based lockfile
 * that prevents two runner processes (or a visible login window and a
 * headless session) from using the same profile simultaneously.
 *
 * Lock rules:
 * - acquire() fails with RUNNER_PROFILE_LOCKED when a live owner holds it.
 * - A stale lock (dead PID) is recovered; a lock owned by a LIVE process is
 *   never deleted.
 * - release() only removes the lock file it owns.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RunnerLogger } from './logging.ts';

export const PROFILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function runnerDataDir(): string {
  const override = process.env.XPILOT_DATA_DIR;
  if (override && override.trim()) return path.resolve(override.trim());
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'X-Pilot', 'Runner');
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'X-Pilot', 'Runner');
  return path.join(os.homedir(), '.x-pilot-runner');
}

export class ProfileLockError extends Error {
  readonly holderPid: number;
  readonly holderStartedAt: number;
  constructor(holderPid: number, holderStartedAt: number) {
    super(`RUNNER_PROFILE_LOCKED:${holderPid}`);
    this.name = 'ProfileLockError';
    this.holderPid = holderPid;
    this.holderStartedAt = holderStartedAt;
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // signal 0 probes existence without sending a signal.
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    const code = (error as { code?: string })?.code;
    // ESRCH: no such process. EPERM: exists but owned by another user.
    return code === 'EPERM';
  }
}

export class ProfileLock {
  private readonly file: string;
  private readonly logger: RunnerLogger;
  private held = false;

  constructor(profileDir: string, logger: RunnerLogger = new RunnerLogger()) {
    this.file = `${profileDir}.lock`;
    this.logger = logger;
  }

  async acquire(owner: string): Promise<void> {
    if (this.held) return;
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
    let existing: { pid?: number; startedAt?: number; owner?: string } | undefined;
    try {
      existing = JSON.parse(await fs.promises.readFile(this.file, 'utf8')) as typeof existing;
    } catch { /* absent or unreadable */ }
    if (existing?.pid) {
      if (isProcessAlive(existing.pid)) throw new ProfileLockError(existing.pid, existing.startedAt ?? 0);
      this.logger.warn('stale profile lock recovered (owner process is gone)', { file: this.file, pid: existing.pid });
    }
    const record = { pid: process.pid, startedAt: Date.now(), owner };
    const tmp = `${this.file}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(record), 'utf8');
    try {
      await fs.promises.rename(tmp, this.file);
    } catch {
      try { await fs.promises.unlink(this.file); } catch { /* ignore */ }
      await fs.promises.rename(tmp, this.file);
    }
    this.held = true;
  }

  async release(): Promise<void> {
    if (!this.held) return;
    this.held = false;
    try {
      const current = JSON.parse(await fs.promises.readFile(this.file, 'utf8')) as { pid?: number };
      if (current?.pid === process.pid) await fs.promises.unlink(this.file);
    } catch { /* already gone */ }
  }

  get isHeld(): boolean {
    return this.held;
  }
}

export interface ProfilePaths {
  profileId: string;
  dataDir: string;
  profileDir: string;
  lockFile: string;
}

export function profilePaths(profileId: string, dataDir = runnerDataDir()): ProfilePaths {
  if (!PROFILE_ID_PATTERN.test(profileId)) throw new Error(`RUNNER_INVALID_PROFILE_ID:${profileId}`);
  const dir = path.join(dataDir, 'profiles', profileId);
  return { profileId, dataDir, profileDir: dir, lockFile: `${dir}.lock` };
}

/** Lists known profiles by scanning the profiles directory. */
export function listProfiles(dataDir = runnerDataDir()): Array<{ profileId: string; hasSession: boolean; lastVerifiedAt?: number }> {
  const profilesDir = path.join(dataDir, 'profiles');
  try {
    return fs.readdirSync(profilesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && PROFILE_ID_PATTERN.test(entry.name))
      .map((entry) => {
        const sessionFile = path.join(profilesDir, entry.name, 'Default', 'Cookies');
        let lastVerifiedAt: number | undefined;
        try { lastVerifiedAt = fs.statSync(path.join(profilesDir, entry.name)).mtimeMs; } catch { /* ignore */ }
        return { profileId: entry.name, hasSession: fs.existsSync(sessionFile), lastVerifiedAt };
      });
  } catch {
    return [];
  }
}
