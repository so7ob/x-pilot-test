import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

/**
 * Dedicated build pass for the MV3 content script.
 *
 * content_scripts registered in public/manifest.json run as CLASSIC scripts:
 * Chrome has no ES-module support there. This pass bundles
 * src/content/content-entry.ts (and everything it imports, including the
 * shared domain/x-selectors module) into ONE self-contained IIFE file at
 * dist/content.js with no import/export statements — the form a classic
 * content script can actually execute (issue #15).
 *
 * It runs AFTER the main ESM pass (background service worker + sidepanel)
 * and must never wipe its output: emptyOutDir is false here.
 */
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    sourcemap: false,
    lib: {
      entry: resolve(root, 'src/content/content-entry.ts'),
      name: 'XPilotContent',
      formats: ['iife'],
      fileName: () => 'content.js'
    }
  }
});
