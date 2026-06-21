import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const fixtureRoot = fileURLToPath(new URL('../tests/package/', import.meta.url));
const temporaryRoot = await mkdtemp(join(tmpdir(), 'nunjitsu-types-'));
const packageDirectory = join(temporaryRoot, 'node_modules', 'nunjitsu');

try {
  await mkdir(join(temporaryRoot, 'node_modules'), { recursive: true });
  await symlink(root, packageDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  for (const fixture of ['types.mts', 'types.cts', 'types-legacy.ts']) {
    await cp(join(fixtureRoot, fixture), join(temporaryRoot, fixture));
  }

  const compiler = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  await run(process.execPath, [
    compiler,
    '--noEmit',
    '--strict',
    '--skipLibCheck',
    'false',
    '--target',
    'ES2022',
    '--module',
    'NodeNext',
    '--moduleResolution',
    'NodeNext',
    'types.mts',
    'types.cts',
  ], { cwd: temporaryRoot });
  await run(process.execPath, [
    compiler,
    '--noEmit',
    '--strict',
    '--skipLibCheck',
    'false',
    '--target',
    'ES2022',
    '--module',
    'ESNext',
    '--moduleResolution',
    'Bundler',
    'types.mts',
  ], { cwd: temporaryRoot });
  await run(process.execPath, [
    compiler,
    '--noEmit',
    '--strict',
    '--skipLibCheck',
    'false',
    '--target',
    'ES2022',
    '--module',
    'CommonJS',
    '--moduleResolution',
    'Node',
    'types-legacy.ts',
  ], { cwd: temporaryRoot });
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}
