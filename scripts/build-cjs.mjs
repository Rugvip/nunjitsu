import { build } from 'esbuild';

await build({
  bundle: true,
  entryPoints: ['src/index.cts'],
  format: 'cjs',
  outfile: 'dist/cjs/index.cjs',
  platform: 'node',
  sourcemap: true,
  target: 'node24',
});
