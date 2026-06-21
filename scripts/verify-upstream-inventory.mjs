import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const checkout = process.argv[2];
if (!checkout) {
  throw new Error('Usage: node scripts/verify-upstream-inventory.mjs <nunjucks-checkout>');
}

const inventory = JSON.parse(await readFile(new URL(
  '../tests/compat/upstream-inventory.json',
  import.meta.url,
), 'utf8'));
const testDirectory = join(checkout, 'tests');
const files = (await readdir(testDirectory)).filter(file => file.endsWith('.js')).sort();
const actual = [];

for (const file of files) {
  const relativeFile = `tests/${file}`;
  const source = await readFile(join(testDirectory, file), 'utf8');
  const expression = /\bit\s*\(\s*(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|`((?:\\.|[^`\\])*)`)/g;
  let match;
  let ordinal = 0;
  while ((match = expression.exec(source)) !== null) {
    ordinal += 1;
    actual.push({
      id: `${relativeFile}:${ordinal}`,
      file: relativeFile,
      line: source.slice(0, match.index).split('\n').length,
      testNameSource: match[1] ?? match[2] ?? match[3],
    });
  }
}

if (JSON.stringify(actual) !== JSON.stringify(inventory.entries)) {
  const expectedById = new Map(inventory.entries.map(entry => [entry.id, entry]));
  const actualById = new Map(actual.map(entry => [entry.id, entry]));
  const differences = new Set([...expectedById.keys(), ...actualById.keys()]);
  const messages = [];
  for (const id of differences) {
    const expected = expectedById.get(id);
    const received = actualById.get(id);
    if (JSON.stringify(expected) !== JSON.stringify(received)) {
      messages.push(`${id}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(received)}`);
    }
  }
  throw new Error(`Upstream inventory differs:\n${messages.join('\n')}`);
}

console.log(`Verified ${actual.length} upstream tests at ${inventory.baseline.commit}`);
