import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
  target: 'node22',
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
  const declarations = new URL('src/', declarationOutput);
  await Promise.all([
    copyDeclarationTree(declarations, new URL('types/legacy/', dist), '.d.ts', ''),
    copyDeclarationTree(declarations, new URL('types/esm/', dist), '.d.mts', '.mjs'),
    copyDeclarationTree(declarations, new URL('types/cjs/', dist), '.d.cts', '.cjs'),
  ]);
} finally {
  await rm(declarationOutput, { force: true, recursive: true });
}

async function copyDeclarationTree(source, destination, declarationExtension, importExtension) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourceEntry = new URL(entry.name, source);
    if (entry.isDirectory()) {
      await copyDeclarationTree(
        new URL(`${entry.name}/`, source),
        new URL(`${entry.name}/`, destination),
        declarationExtension,
        importExtension,
      );
      continue;
    }
    if (!entry.name.endsWith('.d.ts')) {
      continue;
    }
    const outputName = `${entry.name.slice(0, -5)}${declarationExtension}`;
    const sourceText = await readFile(sourceEntry, 'utf8');
    const outputText = sourceText.replace(
      /(['"])(\.\.?\/[^'"]+)\.ts\1/g,
      (_match, quote, specifier) => `${quote}${specifier}${importExtension}${quote}`,
    );
    await writeFile(new URL(outputName, destination), outputText);
  }
}
