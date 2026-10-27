import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));

test('resolves browser exports and ships a self-contained ESM bundle', async () => {
  const { stdout } = await run(process.execPath, [
    '--conditions=browser', '--input-type=module', '-e',
    'console.log(import.meta.resolve("nunjitsu")); console.log((await import("nunjitsu")).createTemplateRenderer().render("browser"));',
  ], { cwd: root });
  assert.match(stdout, /\/dist\/browser\/index\.js\nbrowser/);
  assert.deepEqual((await readdir(new URL('../../dist/browser/', import.meta.url))).sort(), [
    'index.js', 'index.js.map',
  ]);
  const bundle = await readFile(new URL('../../dist/browser/index.js', import.meta.url), 'utf8');
  assert.doesNotMatch(bundle, /\b(?:Buffer|process)\s*\.|\brequire\s*\(|node:/);
  assert.doesNotMatch(bundle, /^import\s/m);
});

test('browser bundle passes compatibility and boundary checks without Node globals or dynamic execution', async () => {
  await run(process.execPath, [
    '--experimental-vm-modules',
    fileURLToPath(new URL('./browser-check.mjs', import.meta.url)),
  ], { cwd: root });
});
