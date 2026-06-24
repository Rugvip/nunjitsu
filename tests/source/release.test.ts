import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const verifyScript = fileURLToPath(new URL(
  '../../scripts/release/verifyReleaseVersion.mjs',
  import.meta.url,
));
const candidatesScript = fileURLToPath(new URL(
  '../../scripts/release/findReleaseCandidates.mjs',
  import.meta.url,
));
const packageJson = JSON.parse(readFileSync(
  new URL('../../package.json', import.meta.url),
  'utf8',
)) as { version: string };

test('accepts only the exact stable package version release tag', () => {
  const accepted = spawnSync(process.execPath, [verifyScript], {
    encoding: 'utf8',
    env: { ...process.env, RELEASE_TAG: `v${packageJson.version}` },
  });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, new RegExp(`package version ${packageJson.version}`));

  const rejected = spawnSync(process.execPath, [verifyScript], {
    encoding: 'utf8',
    env: { ...process.env, RELEASE_TAG: `v${packageJson.version}.1` },
  });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /does not match package version/);

  const missing = spawnSync(process.execPath, [verifyScript], {
    encoding: 'utf8',
    env: Object.fromEntries(
      Object.entries(process.env).filter(([name]) => name !== 'RELEASE_TAG'),
    ),
  });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /RELEASE_TAG is required/);
});

function git(repository: string, ...arguments_: string[]): string {
  return execFileSync('git', arguments_, {
    cwd: repository,
    encoding: 'utf8',
  }).trim();
}

function commitVersion(
  repository: string,
  version: string,
  message: string,
): string {
  writeFileSync(
    join(repository, 'package.json'),
    `${JSON.stringify({ name: 'fixture', version }, undefined, 2)}\n`,
  );
  git(repository, 'add', 'package.json');
  git(repository, 'commit', '-m', message);
  return git(repository, 'rev-parse', 'HEAD');
}

test('finds every stable version transition at its first-parent commit', () => {
  const repository = mkdtempSync(join(tmpdir(), 'nunjitsu-releases-'));
  git(repository, 'init', '--initial-branch=main');
  git(repository, 'config', 'user.email', 'fixture@example.com');
  git(repository, 'config', 'user.name', 'Fixture');

  const initial = commitVersion(repository, '0.1.0', 'initial');
  writeFileSync(join(repository, 'README.md'), 'no release\n');
  git(repository, 'add', 'README.md');
  git(repository, 'commit', '-m', 'documentation');
  const minor = commitVersion(repository, '0.2.0', 'minor');
  writeFileSync(join(repository, 'README.md'), 'still no release\n');
  git(repository, 'add', 'README.md');
  git(repository, 'commit', '-m', 'more documentation');
  const major = commitVersion(repository, '1.0.0', 'major');

  const result = spawnSync(process.execPath, [candidatesScript], {
    cwd: repository,
    encoding: 'utf8',
    env: {
      ...process.env,
      PUSH_AFTER: major,
      PUSH_BEFORE: initial,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [
    { commit: minor, tag: 'v0.2.0', version: '0.2.0' },
    { commit: major, tag: 'v1.0.0', version: '1.0.0' },
  ]);
});

test('rejects unsupported version transitions', () => {
  const repository = mkdtempSync(join(tmpdir(), 'nunjitsu-releases-'));
  git(repository, 'init', '--initial-branch=main');
  git(repository, 'config', 'user.email', 'fixture@example.com');
  git(repository, 'config', 'user.name', 'Fixture');

  const initial = commitVersion(repository, '0.1.0', 'initial');
  const prerelease = commitVersion(repository, '0.2.0-beta.1', 'prerelease');
  const result = spawnSync(process.execPath, [candidatesScript], {
    cwd: repository,
    encoding: 'utf8',
    env: {
      ...process.env,
      PUSH_AFTER: prerelease,
      PUSH_BEFORE: initial,
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /changes package.json to unsupported version/);
});
