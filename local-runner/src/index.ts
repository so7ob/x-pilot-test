/**
 * X-Pilot Local Runner — Native Messaging host entry point.
 *
 * Wire behavior:
 * - stdin/stdout speak ONLY the framed Native Messaging protocol (4-byte
 *   native-endianness length + UTF-8 JSON). stdout is exclusively protocol
 *   output: all logging goes to stderr / a log file, and console.log is
 *   redirected at startup to guard against accidental protocol corruption.
 * - Invalid or oversized frames are reported as error responses and the loop
 *   continues (the channel survives bad messages).
 * - When stdin closes (Chrome terminated the port), the runner closes the
 *   browser contexts it owns and exits. It never kills unrelated processes.
 */

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { encodeFrame, FrameDecoder, RUNNER_PROTOCOL_VERSION, isValidRunnerRequest, type RunnerResponse } from './protocol.ts';
import { OperationLedger } from './ledger.ts';
import { BrowserManager } from './browser.ts';
import { XFlow } from './x-flow.ts';
import { CommandDispatcher } from './commands.ts';
import { RunnerLogger, type LogLevel } from './logging.ts';
import { runnerDataDir } from './profile-store.ts';

function readPackageVersion(): string {
  try {
    const packageJsonPath = path.resolve(import.meta.dirname, '..', 'package.json');
    return (JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function baseUrlFromEnv(): string {
  return (process.env.XPILOT_X_BASE_URL ?? 'https://x.com').replace(/\/$/, '');
}

function extraHostsFromEnv(): string[] {
  return (process.env.XPILOT_EXTRA_HOSTS ?? '').split(',').map((host) => host.trim().toLowerCase()).filter(Boolean);
}

// stdout belongs to the protocol: force every console.* stream to stderr.
const originalConsoleLog = console.log;
console.log = (...args: unknown[]) => process.stderr.write(`${args.map(String).join(' ')}\n`);
console.info = console.log;
console.debug = (...args: unknown[]) => { if (process.env.XPILOT_LOG_LEVEL === 'debug') process.stderr.write(`${args.map(String).join(' ')}\n`); };

const dataDir = runnerDataDir();
const logger = new RunnerLogger({ logDir: path.join(dataDir, 'logs'), minLevel: (process.env.XPILOT_LOG_LEVEL as LogLevel | undefined) ?? 'info' });

const ledger = new OperationLedger(path.join(dataDir, 'ledger', 'operations.json'), logger);
const browsers = new BrowserManager(logger);
const xFlow = new XFlow({ baseUrl: baseUrlFromEnv(), extraHosts: extraHostsFromEnv() }, logger);

let stdoutQueue: Promise<void> = Promise.resolve();
function writeResponse(response: RunnerResponse): Promise<void> {
  const run = async () => {
    try {
      const frame = encodeFrame(JSON.stringify(response), os.endianness() as 'LE' | 'BE');
      const payload = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
      await new Promise<void>((resolve, reject) => {
        const ok = process.stdout.write(payload, (error) => (error ? reject(error) : resolve()));
        if (ok) resolve();
      });
    } catch (error) {
      logger.error('failed to write protocol response', { message: String(error) });
    }
  };
  stdoutQueue = stdoutQueue.then(run, run);
  return stdoutQueue;
}

const dispatcher = new CommandDispatcher({
  ledger,
  browsers,
  xFlow,
  runnerVersion: readPackageVersion(),
  logger,
  emit: (response) => { void writeResponse(response); },
});

const decoder = new FrameDecoder(os.endianness() as 'LE' | 'BE');

async function handlePayload(payload: string): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    await writeResponse({ protocolVersion: RUNNER_PROTOCOL_VERSION, requestId: `invalid-${Date.now()}`, type: 'RESULT', status: 'ERROR', code: 'RUNNER_INVALID_REQUEST', message: 'payload is not valid JSON', at: Date.now() });
    return;
  }
  if (!isValidRunnerRequest(parsed)) {
    await writeResponse({ protocolVersion: RUNNER_PROTOCOL_VERSION, requestId: `invalid-${Date.now()}`, type: 'RESULT', status: 'ERROR', code: 'RUNNER_INVALID_REQUEST', message: 'request failed schema validation', at: Date.now() });
    return;
  }
  try {
    const response = await dispatcher.dispatch(parsed);
    await writeResponse(response);
  } catch (error) {
    await writeResponse({ protocolVersion: RUNNER_PROTOCOL_VERSION, requestId: parsed.requestId, type: 'RESULT', status: 'ERROR', code: 'RUNNER_ERROR', message: error instanceof Error ? error.message : String(error), at: Date.now() });
  }
}

let shuttingDown = false;
async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('runner shutting down', { reason });
  try {
    await dispatcher.dispatch({ protocolVersion: RUNNER_PROTOCOL_VERSION, requestId: `shutdown-${Date.now()}`, command: 'CLEANUP', workspaceId: 'x-pilot-internal', profileId: 'x-pilot-internal', issuedAt: Date.now() });
  } catch { /* best effort */ }
  try { await stdoutQueue; } catch { /* ignore */ }
  void originalConsoleLog; // keep the original reference explicit for audits
  process.exit(0);
}

process.stdin.on('data', (chunk: Buffer) => {
  let payloads: string[];
  try {
    payloads = decoder.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
  } catch (error) {
    logger.error('protocol framing error; resetting buffer', { message: String(error) });
    void writeResponse({ protocolVersion: RUNNER_PROTOCOL_VERSION, requestId: `frame-${Date.now()}`, type: 'RESULT', status: 'ERROR', code: 'RUNNER_INVALID_REQUEST', message: 'frame exceeded size limits', at: Date.now() });
    return;
  }
  for (const payload of payloads) void handlePayload(payload);
});

process.stdin.on('end', () => { void shutdown('stdin-closed'); });
process.stdin.on('error', () => { void shutdown('stdin-error'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('uncaughtException', (error) => { logger.error('uncaught exception', { message: error.message, stack: error.stack }); });
process.on('unhandledRejection', (reason) => { logger.error('unhandled rejection', { message: String(reason) }); });

void (async () => {
  logger.info('X-Pilot Local Runner starting', {
    version: readPackageVersion(),
    protocol: RUNNER_PROTOCOL_VERSION,
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    dataDir,
    endianness: os.endianness(),
    baseUrl: baseUrlFromEnv(),
    extraHosts: extraHostsFromEnv(),
  });
  await ledger.load();
  const pruned = await ledger.prune();
  if (pruned) logger.info('pruned stale ledger records', { count: pruned });
})();
