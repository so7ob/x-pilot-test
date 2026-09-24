import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Architecture contracts for host observability (issue #9).
 *
 * When Chrome launches the runner, it passes the caller origin
 * (chrome-extension://<id>/) as the first host argument and closes stdin
 * without any message whenever the native messaging port dies early. The
 * runner log could not previously distinguish a Chrome launch from a
 * doctor.ps1/manual launch, nor whether a session ever received a request -
 * which is exactly why the "Error when communicating with the native
 * messaging host." report needed a second round trip to diagnose.
 *
 * The host MUST therefore log, per session: the launch context (argv +
 * callerOrigin + stdio fd kinds), every request received, every response
 * sent, and stdin-close counters (framesReceived / responsesSent).
 */

const root = path.resolve(new URL('..', import.meta.url).pathname);
const hostSource = fs.readFileSync(path.join(root, 'local-runner', 'src', 'index.ts'), 'utf8');
const bridgeSource = fs.readFileSync(path.join(root, 'src', 'runner', 'local-runner-bridge.ts'), 'utf8');
const errorKeysSource = fs.readFileSync(path.join(root, 'src', 'ui', 'services', 'error-messages.ts'), 'utf8');
const enSource = fs.readFileSync(path.join(root, 'src', 'i18n', 'en.ts'), 'utf8');
const arSource = fs.readFileSync(path.join(root, 'src', 'i18n', 'ar.ts'), 'utf8');

test('host logs the launch context: caller origin, stdio kinds, raw argv', () => {
  assert.match(hostSource, /callerOriginFromArgv/, 'index.ts: must parse the chrome-extension:// origin Chrome passes as an argument');
  assert.match(hostSource, /chrome-extension:\/\//, 'index.ts: must detect the chrome-extension:// scheme');
  assert.match(hostSource, /'host process context'/, "index.ts: must log a 'host process context' line at startup");
  assert.match(hostSource, /fdKind\(0\)/, 'index.ts: must classify the stdin fd');
  assert.match(hostSource, /fdKind\(1\)/, 'index.ts: must classify the stdout fd');
  assert.match(hostSource, /argv: process\.argv/, 'index.ts: must log the raw argv');
});

test('host logs every request and every response with counters', () => {
  assert.match(hostSource, /'request received'/, "index.ts: must log 'request received' with command + requestId");
  assert.match(hostSource, /'response sent'/, "index.ts: must log 'response sent' with status/code/bytes");
  assert.match(hostSource, /framesReceived \+= payloads\.length/, 'index.ts: must count received frames');
  assert.match(hostSource, /responsesSent \+= 1/, 'index.ts: must count sent responses');
  assert.match(hostSource, /reason, framesReceived, responsesSent/, 'index.ts: the shutdown detail must include the frame/response counters');
});

test('protocol purity is preserved: logging stays off stdout', () => {
  // The new log lines all go through RunnerLogger (stderr + file), never
  // through process.stdout, which remains reserved for framed responses.
  const start = hostSource.indexOf('function writeResponse');
  const end = hostSource.indexOf('const dispatcher');
  assert.ok(start >= 0 && end > start, 'index.ts: writeResponse must precede the dispatcher');
  const responseWriteBlock = hostSource.slice(start, end);
  assert.ok(responseWriteBlock.includes('process.stdout.write'), 'index.ts: the response path must keep using process.stdout');
  // RunnerLogger writes go to stderr + file only (its implementation is
  // asserted by the runner-side suite); no logger call may touch stdout.
  assert.equal(/logger\.[a-z]+\([^)]*process\.stdout/.test(hostSource), false, 'index.ts: logger calls must never write to stdout');
  const loggingSource = fs.readFileSync(path.join(root, 'local-runner', 'src', 'logging.ts'), 'utf8');
  assert.ok(loggingSource.includes('process.stderr.write'), 'logging.ts: log lines must go to stderr');
  assert.equal(/process\.stdout/.test(loggingSource), false, 'logging.ts: must never reference stdout');
});

test('bridge maps the raw Chrome generic error to RUNNER_PIPE_BROKEN', () => {
  assert.match(bridgeSource, /Error when communicating with the native messaging host\./, 'bridge: must recognize the generic Chrome communication error');
  assert.match(bridgeSource, /RUNNER_PIPE_BROKEN/, 'bridge: must map it to a distinct code');
  assert.match(bridgeSource, /Failed to start native messaging host\./, 'bridge: must recognize the Chrome failed-to-start error');
});

test('error keys and i18n stay in AR/EN parity for the pipe-broken state', () => {
  assert.match(errorKeysSource, /RUNNER_PIPE_BROKEN: 'errors\.runnerPipeBroken'/, 'error-messages: RUNNER_PIPE_BROKEN must map to a translation key');
  assert.match(enSource, /runnerPipeBroken:/, 'en.ts: must define errors.runnerPipeBroken');
  assert.match(arSource, /runnerPipeBroken:/, 'ar.ts: must define errors.runnerPipeBroken');
  const en = /runnerPipeBroken: '([^']+)'/.exec(enSource)?.[1];
  const ar = /runnerPipeBroken: '([^']+)'/.exec(arSource)?.[1];
  assert.ok(en && en.includes('doctor.ps1'), 'en.ts: the guidance must point at doctor.ps1');
  assert.ok(ar && ar.includes('doctor.ps1'), 'ar.ts: the guidance must point at doctor.ps1 (parity)');
});
