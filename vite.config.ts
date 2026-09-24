import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        // NOTE: the content script is intentionally NOT part of this ESM pass.
        // MV3 manifest content_scripts are classic scripts (no import support),
        // so content.js must be built as a self-contained IIFE by the dedicated
        // second pass in vite.content.config.ts. Bundling it here made Rollup
        // hoist the shared x-selectors chunk and ship an ES-module content.js
        // that crashes with "Cannot use import statement outside a module"
        // (issue #15, regression in v1.5.0–v1.5.4).
        sidepanel: resolve(root, 'index.html'),
        background: resolve(root, 'src/background/service-worker.ts')
      },
      output: {
        entryFileNames: (chunk) => chunk.name === 'sidepanel' ? 'assets/[name].js' : '[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]'
      }
    }
  }
});
