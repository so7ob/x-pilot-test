import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * Content-script packaging contracts (issue #15).
 *
 * MV3 manifest content_scripts are CLASSIC scripts: Chrome executes them
 * without ES-module support. A content.js that starts with (or contains a
 * top-level) `import ... from "./assets/..."` dies immediately with
 * "Cannot use import statement outside a module", the message listener never
 * installs, and every chrome.tabs.sendMessage from the background fails with
 * "Could not establish connection. Receiving end does not exist."
 *
 * These contracts pin the two-pass build that guarantees a self-contained
 * IIFE content script, and verify the actual built artifact when a build
 * exists (the release pipeline always builds before testing).
 */

const root = path.resolve(new URL('..', import.meta.url).pathname);
const distDir = path.join(root, 'dist');
const contentPath = path.join(distDir, 'content.js');

const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

/** All assertions a classic (non-module) content script bundle must satisfy. */
function assertClassicContentScript(source, label) {
  // 1. No top-level / minified ESM import binding (the v1.5.0–v1.5.4 defect).
  assert.doesNotMatch(source, /(?:^|[;}\s])import\s*[{*\s"']/, `${label}: must not contain an import statement (classic scripts cannot execute ES modules)`);
  // 2. No reference to a sibling chunk — the bundle must be self-contained.
  assert.doesNotMatch(source, /from\s*["']\.\/assets\//, `${label}: must not import from ./assets/ chunks (must be self-contained)`);
  // 3. No export statements either (IIFE has none).
  assert.doesNotMatch(source, /(?:^|[;}\s])export\s*[{*d\s]/, `${label}: must not contain an export statement`);
  // 4. The runtime listener guard + message handling must be present.
  assert.ok(source.includes('__xPilotContentListenerInstalled'), `${label}: listener install guard missing`);
  assert.ok(source.includes('chrome.runtime.onMessage.addListener'), `${label}: onMessage listener missing`);
  for (const messageType of ['X_INSPECT', 'X_PUBLISH', 'X_GET_PUBLISHED_URL', 'X_COLLECT_PUBLISH_EVIDENCE']) {
    assert.ok(source.includes(`\`${messageType}\``) || source.includes(`"${messageType}"`) || source.includes(`'${messageType}'`), `${label}: ${messageType} handler missing`);
  }
}

test('vite main pass never emits the content script (dedicated IIFE pass owns it)', () => {
  const mainConfig = read('vite.config.ts');
  assert.ok(mainConfig.includes('vite.content.config.ts'), 'vite.config.ts must document the dedicated content pass');
  assert.doesNotMatch(mainConfig, /content:\s*resolve\(root,\s*'src\/content\/content-entry\.ts'\)/, 'the ESM pass must not take the content script as input (that produced the broken module content.js)');
});

test('vite.content.config.ts pins the IIFE contract for dist/content.js', () => {
  const config = read('vite.content.config.ts');
  assert.ok(config.includes("resolve(root, 'src/content/content-entry.ts')"), 'content pass entry must be src/content/content-entry.ts');
  assert.ok(config.includes("formats: ['iife']"), 'content pass must emit an IIFE bundle (classic script)');
  assert.ok(config.includes("fileName: () => 'content.js'"), 'content pass must write dist/content.js');
  assert.ok(config.includes('emptyOutDir: false'), 'content pass must never wipe the ESM pass output');
});

test('package.json build script runs both passes in order', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.scripts.build, /^tsc -b && vite build && vite build --config vite\.content\.config\.ts( .*)?$/, 'build must run the ESM pass then the IIFE content pass');
});

test('manifest registers content.js as a classic content script on X origins', () => {
  const manifest = JSON.parse(read('public/manifest.json'));
  const entry = (manifest.content_scripts ?? []).find((script) => (script.js ?? []).includes('content.js'));
  assert.ok(entry, 'manifest content_scripts must register content.js');
  assert.deepEqual(entry.js, ['content.js'], 'content.js must be the only file (self-contained bundle)');
  assert.ok(entry.matches.some((pattern) => pattern.includes('x.com')), 'content script must match x.com');
});

test('built dist/content.js is a self-contained classic script when a build exists', { skip: !fs.existsSync(distDir) && 'no build output yet — run npm run build' }, () => {
  assert.ok(fs.existsSync(contentPath), 'dist exists but dist/content.js is missing — the IIFE pass did not run');
  const source = fs.readFileSync(contentPath, 'utf8');
  assert.ok(source.length > 500, 'dist/content.js looks empty');
  assertClassicContentScript(source, 'dist/content.js');
  // The authoritative classic-script check: Node parses the file as a
  // CommonJS classic script — an ESM import statement fails this parse.
  const check = spawnSync(process.execPath, ['--check', contentPath], { encoding: 'utf8' });
  assert.equal(check.status, 0, `node --check (classic script parse) failed:\n${check.stderr}`);
  // The dist manifest must still register the content script.
  const distManifest = JSON.parse(fs.readFileSync(path.join(distDir, 'manifest.json'), 'utf8'));
  assert.ok((distManifest.content_scripts ?? []).some((script) => (script.js ?? []).includes('content.js')), 'dist/manifest.json must register content.js');
});

test('tripwire: the contract detector rejects the v1.5.0–v1.5.4 broken bundle', () => {
  // Shape of the shipped defect: a shared-chunk import at the top of
  // dist/content.js (taken from the v1.5.4 build).
  const brokenBundle = 'import{a as e,d as t}from"./assets/x-selectors-DNO2kYyn.js";chrome.runtime.onMessage.addListener((m,s,n)=>{n({ok:true});return true;});';
  assert.throws(() => assertClassicContentScript(brokenBundle, 'synthetic v1.5.4 bundle'), /must not contain an import statement/);
});
