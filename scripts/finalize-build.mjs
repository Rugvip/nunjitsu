import { writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
await writeFile(
  new URL('dist/cjs/package.json', root),
  `${JSON.stringify({ type: 'commonjs' }, undefined, 2)}\n`,
);
