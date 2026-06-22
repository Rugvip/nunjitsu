import { mkdir, writeFile } from 'node:fs/promises';

import { collectNunjucksInventory } from './collectNunjucksInventory.mjs';

const baseline = Object.freeze({
  repository: 'https://github.com/mozilla/nunjucks.git',
  tag: 'v3.2.4',
  commit: '86a77f49da4779d55414d8337e1a4d7ec7582da5',
});
const upstreamRoot = process.argv[2];
if (!upstreamRoot) {
  throw new Error(
    'Usage: node scripts/compat/importNunjucksInventory.mjs <nunjucks-v3.2.4-root>',
  );
}

const target = new URL('../../tests/compat/upstream-inventory.json', import.meta.url);
const entries = await collectNunjucksInventory(upstreamRoot);
await mkdir(new URL('./', target), { recursive: true });
await writeFile(target, `${JSON.stringify({ schemaVersion: 1, baseline, entries }, null, 2)}\n`);
