import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

export async function collectNunjucksInventory(upstreamRoot) {
  const entries = [];
  for (const file of await walk(join(upstreamRoot, 'tests'))) {
    if (!file.endsWith('.js')) {
      continue;
    }
    const source = await readFile(file, 'utf8');
    const relativeFile = relative(upstreamRoot, file).replaceAll('\\', '/');
    const pattern = /\bit\s*\(\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1\s*,/g;
    let match;
    let ordinal = 0;
    while ((match = pattern.exec(source)) !== null) {
      ordinal += 1;
      entries.push({
        id: `${relativeFile}:${ordinal}`,
        file: relativeFile,
        line: source.slice(0, match.index).split('\n').length,
        testNameSource: match[2],
      });
    }
  }
  return entries;
}

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
