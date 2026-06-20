import { copyFile, mkdir, writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const wasmDirectory = new URL('dist/wasm/', root);

await mkdir(wasmDirectory, { recursive: true });
await copyFile(
  new URL('rust/target/wasm32-unknown-unknown/release/nunjitsu_engine.wasm', root),
  new URL('nunjitsu_engine.wasm', wasmDirectory),
);
await writeFile(
  new URL('dist/cjs/package.json', root),
  `${JSON.stringify({ type: 'commonjs' }, undefined, 2)}\n`,
);
