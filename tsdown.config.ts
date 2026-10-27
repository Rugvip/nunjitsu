import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsdown';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    fixedExtension: false,
    format: ['esm', 'cjs'],
    platform: 'node',
    sourcemap: true,
    dts: {
      sourcemap: true,
    },
  },
  {
    entry: ['src/index.ts'],
    outDir: 'dist/browser',
    fixedExtension: false,
    format: ['esm'],
    platform: 'browser',
    target: 'es2023',
    dts: false,
    sourcemap: true,
    alias: {
      [fileURLToPath(new URL('./src/runtime/platform.ts', import.meta.url))]:
        fileURLToPath(new URL('./src/runtime/platform.browser.ts', import.meta.url)),
    },
  },
]);
