import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFrame, FrameDecoder, isValidRunnerRequest, RUNNER_HOST_NAME, RUNNER_MAX_MESSAGE_BYTES, RUNNER_PROTOCOL_VERSION, RUNNER_COMMANDS } from '../src/runner/protocol.ts';

const ARABIC_EMOJI = { command: 'PUBLISH', requestId: 'req-مرحبا-🌍-🚀', payload: { targetUrl: 'https://x.com/intent/post?text=' + encodeURIComponent('نص عربي 🇸🇦 مع رموز 🎉') } };

test('extension-side framing writes UTF-8 BYTE lengths for Arabic and emoji', () => {
  const json = JSON.stringify(ARABIC_EMOJI);
  const frame = encodeFrame(json);
  const header = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0, true);
  assert.equal(header, new TextEncoder().encode(json).byteLength);
  assert.ok(header > json.length);
});

test('extension-side decoder handles fragmented and coalesced frames', () => {
  const first = encodeFrame(JSON.stringify({ a: 'عربي' }));
  const second = encodeFrame(JSON.stringify({ b: '🎉' }));
  const merged = new Uint8Array(first.byteLength + second.byteLength);
  merged.set(first, 0);
  merged.set(second, first.byteLength);
  const decoder = new FrameDecoder();
  assert.equal(decoder.push(merged).length, 2);
  const single = new FrameDecoder();
  const parts = [];
  for (const byte of merged) parts.push(single.push(new Uint8Array([byte])));
  assert.equal(parts.flat().filter(Boolean).length, 2);
});

test('host name and caps match the registered Windows host', () => {
  assert.equal(RUNNER_HOST_NAME, 'com.so7ob.x_pilot_runner');
  assert.equal(RUNNER_PROTOCOL_VERSION, 1);
  assert.equal(RUNNER_MAX_MESSAGE_BYTES, 1_000_000);
  assert.equal(RUNNER_COMMANDS.includes('PUBLISH'), true);
  assert.equal(RUNNER_COMMANDS.includes('EVAL'), false);
});

test('request validation rejects command-injection-shaped payloads', () => {
  const valid = { protocolVersion: 1, requestId: 'r', command: 'INSPECT', workspaceId: 'w', profileId: 'w', payload: { targetUrl: 'https://x.com/intent/post' }, issuedAt: 1 };
  assert.equal(isValidRunnerRequest(valid), true);
  for (const mutation of [
    { ...valid, command: 'RUN_JS' },
    { ...valid, command: 'READ_FILE' },
    { ...valid, payload: ['array'] },
    { ...valid, requestId: 'x'.repeat(200) },
    { ...valid, issuedAt: 'now' },
  ]) assert.equal(isValidRunnerRequest(mutation), false);
});
