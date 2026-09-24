import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFrame, FrameDecoder, isValidRunnerRequest, RUNNER_MAX_MESSAGE_BYTES, RUNNER_PROTOCOL_VERSION, RUNNER_COMMANDS } from '../src/protocol.ts';

const ARABIC_EMOJI = { command: 'PUBLISH', requestId: 'req-عربي-🎉-🚀', payload: { targetUrl: 'https://x.com/intent/post?text=' + encodeURIComponent('مرحبا بالعالم 🌍\nسطر جديد 🇸🇦') } };

test('frame length header counts UTF-8 BYTES, not characters', () => {
  const json = JSON.stringify(ARABIC_EMOJI);
  const frame = encodeFrame(json);
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const headerLength = view.getUint32(0, true);
  const bodyBytes = new TextEncoder().encode(json).byteLength;
  assert.equal(headerLength, bodyBytes);
  assert.equal(frame.byteLength, 4 + bodyBytes);
  assert.ok(headerLength > json.length, 'multi-byte Arabic/emoji payload must have byte length > char length');
});

test('round-trips Arabic and emoji payloads', () => {
  const json = JSON.stringify(ARABIC_EMOJI);
  const frame = encodeFrame(json);
  const decoder = new FrameDecoder();
  const [payload] = decoder.push(frame);
  assert.deepEqual(JSON.parse(payload), ARABIC_EMOJI);
});

test('decodes fragmented messages delivered byte-by-byte', () => {
  const json = JSON.stringify({ msg: 'تجزئة الرسالة 🧩 عبر أجزاء متعددة', emoji: '🔥' });
  const frame = encodeFrame(json);
  const decoder = new FrameDecoder();
  const collected = [];
  for (const byte of frame) collected.push(decoder.push(new Uint8Array([byte])));
  const payloads = collected.flat().filter(Boolean);
  assert.deepEqual(payloads.map((payload) => JSON.parse(payload)), [JSON.parse(json)]);
});

test('decodes multiple coalesced messages in one chunk', () => {
  const first = encodeFrame(JSON.stringify({ command: 'PING', requestId: 'one' }));
  const second = encodeFrame(JSON.stringify({ command: 'PING', requestId: 'عربي' }));
  const merged = new Uint8Array(first.byteLength + second.byteLength);
  merged.set(first, 0);
  merged.set(second, first.byteLength);
  const decoder = new FrameDecoder();
  const payloads = decoder.push(merged);
  assert.equal(payloads.length, 2);
  assert.deepEqual(payloads.map((payload) => JSON.parse(payload).requestId), ['one', 'عربي']);
});

test('big-endian framing writes the header in big-endian order', () => {
  const json = JSON.stringify({ command: 'PING', requestId: 'be-🧭' });
  const frame = encodeFrame(json, 'BE');
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const expected = new TextEncoder().encode(json).byteLength;
  assert.equal(view.getUint32(0, false), expected);
  const decoder = new FrameDecoder('BE');
  assert.equal(decoder.push(frame).length, 1);
});

test('rejects frames exceeding the 1 MiB host-to-Chrome cap', () => {
  const huge = 'x'.repeat(RUNNER_MAX_MESSAGE_BYTES + 10);
  assert.throws(() => encodeFrame(huge), /RUNNER_MESSAGE_TOO_LARGE/);
});

test('decoder rejects absurd length headers and resets', () => {
  const decoder = new FrameDecoder();
  const evil = new Uint8Array(8);
  new DataView(evil.buffer).setUint32(0, 0x7fffffff, true);
  assert.throws(() => decoder.push(evil), /RUNNER_FRAME_TOO_LARGE/);
  // Decoder recovers and processes a valid frame afterwards.
  const valid = encodeFrame(JSON.stringify({ command: 'PING' }));
  assert.equal(decoder.push(valid).length, 1);
});

test('request validation accepts a valid publish request and rejects malformed ones', () => {
  const valid = { protocolVersion: RUNNER_PROTOCOL_VERSION, requestId: 'req-1', command: 'PUBLISH', workspaceId: 'ws-1', profileId: 'ws-1', operationId: 'op-1', payload: { targetUrl: 'https://x.com/intent/post?text=%D9%85%D8%B1%D8%AD%D8%A8%D8%A7' }, issuedAt: Date.now() };
  assert.equal(isValidRunnerRequest(valid), true);
  assert.equal(isValidRunnerRequest({ ...valid, protocolVersion: 'x' }), false);
  assert.equal(isValidRunnerRequest({ ...valid, command: 'RUN_SHELL' }), false);
  assert.equal(isValidRunnerRequest({ ...valid, requestId: '' }), false);
  assert.equal(isValidRunnerRequest({ ...valid, payload: 'not-an-object' }), false);
  assert.equal(isValidRunnerRequest(null), false);
});

test('command allowlist contains exactly the supported commands', () => {
  assert.deepEqual([...RUNNER_COMMANDS], ['PING', 'GET_INFO', 'INSPECT', 'PUBLISH', 'GET_OPERATION', 'CANCEL', 'OPEN_LOGIN', 'CLOSE_LOGIN', 'CLEANUP']);
});
