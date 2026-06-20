import { build } from 'esbuild';

await Promise.all([
  build({
    bundle: true,
    entryPoints: ['src/index.cts'],
    format: 'cjs',
    outfile: 'dist/cjs/index.cjs',
    platform: 'node',
    sourcemap: true,
    target: 'node24',
  }),
  build({
    bundle: true,
    entryPoints: ['src/worker.ts'],
    format: 'cjs',
    outfile: 'dist/cjs/worker.cjs',
    platform: 'node',
    sourcemap: true,
    target: 'node24',
  }),
]);
