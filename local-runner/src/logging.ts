/**
 * Runner logging: stdout is RESERVED for the Native Messaging protocol.
 * All diagnostics go to stderr and to a rotating local log file.
 */

import fs from 'node:fs';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const MAX_LOG_FILES = 3;

export class RunnerLogger {
  private readonly filePath?: string;
  private readonly minLevel: LogLevel;

  constructor(options: { logDir?: string; minLevel?: LogLevel; fileBaseName?: string } = {}) {
    this.minLevel = options.minLevel ?? 'info';
    this.filePath = options.logDir ? path.join(options.logDir, `${options.fileBaseName ?? 'runner'}.log`) : undefined;
    if (this.filePath) {
      try {
        fs.mkdirSync(options.logDir!, { recursive: true });
        rotateIfNeeded(this.filePath);
      } catch { /* logging must never break the protocol */ }
    }
  }

  log(level: LogLevel, message: string, detail?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;
    const line = JSON.stringify({ at: new Date().toISOString(), level, message, ...(detail ? { detail } : {}) });
    process.stderr.write(`${line}\n`);
    if (this.filePath) {
      try {
        rotateIfNeeded(this.filePath);
        fs.appendFileSync(this.filePath, `${line}\n`);
      } catch { /* ignore file logging failures */ }
    }
  }

  debug = (message: string, detail?: Record<string, unknown>) => this.log('debug', message, detail);
  info = (message: string, detail?: Record<string, unknown>) => this.log('info', message, detail);
  warn = (message: string, detail?: Record<string, unknown>) => this.log('warn', message, detail);
  error = (message: string, detail?: Record<string, unknown>) => this.log('error', message, detail);
}

function rotateIfNeeded(filePath: string): void {
  try {
    const stats = fs.statSync(filePath);
    if (stats.size < MAX_LOG_BYTES) return;
    for (let index = MAX_LOG_FILES - 1; index >= 1; index -= 1) {
      const from = `${filePath}.${index}`;
      const to = `${filePath}.${index + 1}`;
      if (fs.existsSync(from)) fs.renameSync(from, to);
    }
    fs.renameSync(filePath, `${filePath}.1`);
  } catch { /* first run or concurrent rotation */ }
}
