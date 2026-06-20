import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const baseline = Object.freeze({
  repository: 'https://github.com/mozilla/nunjucks.git',
  tag: 'v3.2.4',
  commit: '86a77f49da4779d55414d8337e1a4d7ec7582da5',
});
const upstreamRoot = process.argv[2];
if (!upstreamRoot) {
  throw new Error('Usage: node scripts/import-nunjucks-inventory.mjs <nunjucks-v3.2.4-root>');
}

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const testsRoot = join(upstreamRoot, 'tests');
const entries = [];
for (const file of await walk(testsRoot)) {
  if (!file.endsWith('.js')) {
    continue;
  }
  const source = await readFile(file, 'utf8');
  const pattern = /\bit\s*\(\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1\s*,/g;
  let match;
  let ordinal = 0;
  while ((match = pattern.exec(source))) {
    ordinal += 1;
    entries.push({
      id: `${relative(upstreamRoot, file)}:${ordinal}`,
      file: relative(upstreamRoot, file),
      line: source.slice(0, match.index).split('\n').length,
      testNameSource: match[2],
    });
  }
}

const target = join(repositoryRoot, 'tests/compat/upstream-inventory.json');
await mkdir(dirname(target), { recursive: true });
await writeFile(target, `${JSON.stringify({ schemaVersion: 1, baseline, entries }, null, 2)}\n`);

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(path));
    } else {
      files.push(path);
    }
  }
  return files;
}
