import { execFile } from 'node:child_process';
import { rename, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const run = promisify(execFile);
const root = new URL('../', import.meta.url);
const dist = new URL('dist/', root);
const declarationOutput = new URL('.declarations/', dist);
const entryPoint = fileURLToPath(new URL('src/index.ts', root));
const sharedBuildOptions = {
  bundle: true,
  entryPoints: [entryPoint],
  platform: 'node',
  sourcemap: true,
  target: 'node24',
};

await rm(dist, { force: true, recursive: true });
try {
  await Promise.all([
    build({
      ...sharedBuildOptions,
      format: 'esm',
      outfile: fileURLToPath(new URL('esm/index.js', dist)),
    }),
    build({
      ...sharedBuildOptions,
      format: 'cjs',
      outfile: fileURLToPath(new URL('cjs/index.cjs', dist)),
    }),
    run(process.execPath, [
      fileURLToPath(new URL('node_modules/@typescript/native-preview/bin/tsgo.js', root)),
      '-p',
      fileURLToPath(new URL('tsconfig.json', root)),
      '--noEmit',
      'false',
      '--emitDeclarationOnly',
      '--outDir',
      fileURLToPath(declarationOutput),
    ]),
  ]);
  await rename(new URL('src/', declarationOutput), new URL('types/', dist));
} finally {
  await rm(declarationOutput, { force: true, recursive: true });
}
