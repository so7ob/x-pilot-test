import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('../..', import.meta.url).pathname);
const extensionProtocol = fs.readFileSync(path.join(root, 'src/runner/protocol.ts'), 'utf8');
const runnerProtocol = fs.readFileSync(path.join(root, 'local-runner/src/protocol.ts'), 'utf8');
const extensionSelectors = fs.readFileSync(path.join(root, 'src/domain/x-selectors.ts'), 'utf8');
const runnerSelectors = fs.readFileSync(path.join(root, 'local-runner/src/x-selectors.ts'), 'utf8');

function extractNamedExport(source, name) {
  const match = source.match(new RegExp(`export const ${name}(:[^=]+)? = (\\[[\\s\\S]*?\\]|'[^']*'|\\d+);`));
  return match?.[2]?.replace(/\s+/g, ' ');
}

test('protocol version, host name, and size caps match on both sides', () => {
  for (const name of ['RUNNER_PROTOCOL_VERSION', 'RUNNER_HOST_NAME', 'RUNNER_MAX_MESSAGE_BYTES', 'RUNNER_MAX_FRAME_BYTES']) {
    assert.equal(extractNamedExport(extensionProtocol, name), extractNamedExport(runnerProtocol, name), `${name} must be identical in the extension and runner protocol mirrors`);
  }
});

test('command allowlist matches on both sides', () => {
  assert.equal(extractNamedExport(extensionProtocol, 'RUNNER_COMMANDS'), extractNamedExport(runnerProtocol, 'RUNNER_COMMANDS'));
});

test('selector arrays match on both sides', () => {
  for (const name of ['composerSelectors', 'postButtonSelectors', 'accountLinkSelectors', 'confirmationToastSelectors']) {
    assert.equal(extractNamedExport(extensionSelectors, name), extractNamedExport(runnerSelectors, name), `${name} must be identical in the extension and runner selector mirrors`);
  }
});

test('label and limit patterns match on both sides', () => {
  for (const name of ['publishTestIdPattern', 'excludedLabelPattern', 'publishLabelPattern', 'dailyPostLimitPattern']) {
    assert.equal(extractNamedExport(extensionSelectors, name), extractNamedExport(runnerSelectors, name), `${name} must be identical in the extension and runner selector mirrors`);
  }
});

test('composer text normalization handles Arabic, emoji, and newlines identically', async () => {
  const extension = await import(path.join(root, 'src/domain/x-selectors.ts'));
  const runner = await import(path.join(root, 'local-runner/src/x-selectors.ts'));
  const samples = ['  مرحبا   بالعالم  ', 'سطر أول\nسطر ثانٍ\n', 'emoji 🎉🚀\u200D test', 'zero\u200Bwidth', 'نَشْر\tمُnormalized'];
  for (const sample of samples) {
    assert.equal(extension.normalizeComposerText(sample), runner.normalizeComposerText(sample));
    assert.equal(extension.normalizeControlLabel(sample), runner.normalizeControlLabel(sample));
  }
});

test('intent URL content parsing matches on both sides (Arabic + emoji + newlines)', async () => {
  const extensionIntent = await import(path.join(root, 'src/domain/intent-url.ts'));
  const runnerSelectorsModule = await import(path.join(root, 'local-runner/src/x-selectors.ts'));
  const text = encodeURIComponent('مرحبا 🌍\nنص عربي متعدد الأسطر 🇸🇦');
  const url = `https://x.com/intent/post?text=${text}`;
  assert.equal(extensionIntent.publishContentFromIntentUrl(url), runnerSelectorsModule.publishContentFromIntentUrl(url));
  assert.equal(extensionIntent.publishContentFromIntentUrl('https://x.com/intent/post'), undefined);
  assert.equal(runnerSelectorsModule.publishContentFromIntentUrl('https://evil.example/intent/post?text=x'), undefined);
});
