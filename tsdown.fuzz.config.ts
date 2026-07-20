import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: [
    'fuzz/parser.fuzz.ts',
    'fuzz/render.fuzz.ts',
  ],
  outDir: '.fuzz/targets',
  clean: true,
  fixedExtension: false,
  format: ['esm'],
  platform: 'node',
  sourcemap: true,
  dts: false,
});
