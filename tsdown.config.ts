import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  fixedExtension: false,
  format: ['esm', 'cjs'],
  platform: 'node',
  sourcemap: true,
  dts: {
    resolver: 'tsc',
    sourcemap: true,
  },
});
