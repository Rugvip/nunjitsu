import { readFile } from 'node:fs/promises';

import { collectNunjucksInventory } from './collectNunjucksInventory.mjs';

const checkout = process.argv[2];
if (!checkout) {
  throw new Error(
    'Usage: node scripts/compat/verifyNunjucksInventory.mjs <nunjucks-checkout>',
  );
}

const inventory = JSON.parse(await readFile(new URL(
  '../../tests/compat/upstream-inventory.json',
  import.meta.url,
), 'utf8'));
const actual = await collectNunjucksInventory(checkout);

if (JSON.stringify(actual) !== JSON.stringify(inventory.entries)) {
  const expectedById = new Map(inventory.entries.map(entry => [entry.id, entry]));
  const actualById = new Map(actual.map(entry => [entry.id, entry]));
  const differences = new Set([...expectedById.keys(), ...actualById.keys()]);
  const messages = [];
  for (const id of differences) {
    const expected = expectedById.get(id);
    const received = actualById.get(id);
    if (JSON.stringify(expected) !== JSON.stringify(received)) {
      messages.push(
        `${id}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(received)}`,
      );
    }
  }
  throw new Error(`Upstream inventory differs:\n${messages.join('\n')}`);
}

process.stdout.write(
  `Verified ${actual.length} upstream tests at ${inventory.baseline.commit}\n`,
);
