import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProfileLock, isProcessAlive, profilePaths, listProfiles, runnerDataDir, PROFILE_ID_PATTERN } from '../src/profile-store.ts';
import { RunnerLogger } from '../src/logging.ts';

const silentLogger = new RunnerLogger({ minLevel: 'error' });

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'x-pilot-profile-'));
}

test('profile paths live under the runner data dir, never the repository', () => {
  const dataDir = tmpDir();
  const paths = profilePaths('ws-1', dataDir);
  assert.equal(paths.profileDir, path.join(dataDir, 'profiles', 'ws-1'));
  assert.equal(paths.lockFile, `${path.join(dataDir, 'profiles', 'ws-1')}.lock`);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('rejects unsafe profile ids', () => {
  assert.throws(() => profilePaths('../escape', tmpDir()), /RUNNER_INVALID_PROFILE_ID/);
  assert.throws(() => profilePaths('a'.repeat(65), tmpDir()), /RUNNER_INVALID_PROFILE_ID/);
  assert.equal(PROFILE_ID_PATTERN.test('valid-id_1'), true);
});

test('a live lock holder blocks a second acquire with RUNNER_PROFILE_LOCKED', async () => {
  const dir = tmpDir();
  const lock = new ProfileLock(path.join(dir, 'profiles', 'p1'), silentLogger);
  await lock.acquire('headless-session');
  const second = new ProfileLock(path.join(dir, 'profiles', 'p1'), silentLogger);
  await assert.rejects(() => second.acquire('login-window'), (error) => {
    assert.match(error.message, /RUNNER_PROFILE_LOCKED/);
    assert.equal(isProcessAlive(error.holderPid), true);
    return true;
  });
  await lock.release();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a stale lock (dead owner PID) is recovered automatically', async () => {
  const dir = tmpDir();
  const lockFile = path.join(dir, 'profiles', 'p1.lock');
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 999_999_999, startedAt: 1, owner: 'ghost' }), 'utf8');
  const lock = new ProfileLock(path.join(dir, 'profiles', 'p1'), silentLogger);
  await lock.acquire('new-owner'); // must not throw
  const content = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  assert.equal(content.pid, process.pid);
  await lock.release();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('release removes only the lock owned by this process', async () => {
  const dir = tmpDir();
  const lockFile = path.join(dir, 'profiles', 'p1.lock');
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const lock = new ProfileLock(path.join(dir, 'profiles', 'p1'), silentLogger);
  await lock.acquire('me');
  // Simulate an external (dead) owner overwriting our lock record.
  const foreign = { pid: 999_999_999, startedAt: 1, owner: 'other' };
  fs.writeFileSync(lockFile, JSON.stringify(foreign), 'utf8');
  await lock.release();
  assert.deepEqual(JSON.parse(fs.readFileSync(lockFile, 'utf8')), foreign);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('runnerDataDir respects the environment override and platform defaults', () => {
  const previous = process.env.XPILOT_DATA_DIR;
  try {
    process.env.XPILOT_DATA_DIR = path.join(os.tmpdir(), 'custom-data');
    assert.equal(runnerDataDir(), path.resolve(process.env.XPILOT_DATA_DIR));
    delete process.env.XPILOT_DATA_DIR;
    const defaultDir = runnerDataDir();
    if (process.platform === 'win32') assert.match(defaultDir, /X-Pilot[\\/]Runner/);
    else assert.ok(defaultDir.includes('x-pilot'), defaultDir);
  } finally {
    if (previous) process.env.XPILOT_DATA_DIR = previous; else delete process.env.XPILOT_DATA_DIR;
  }
});

test('listProfiles reports existing profile directories with session state', () => {
  const dataDir = tmpDir();
  fs.mkdirSync(path.join(dataDir, 'profiles', 'alpha', 'Default'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'profiles', 'alpha', 'Default', 'Cookies'), '');
  fs.mkdirSync(path.join(dataDir, 'profiles', 'beta'), { recursive: true });
  const profiles = listProfiles(dataDir);
  assert.deepEqual(profiles.map((profile) => profile.profileId).sort(), ['alpha', 'beta']);
  assert.equal(profiles.find((profile) => profile.profileId === 'alpha').hasSession, true);
  assert.equal(profiles.find((profile) => profile.profileId === 'beta').hasSession, false);
  fs.rmSync(dataDir, { recursive: true, force: true });
});
