import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../scripts/verify-release-version.mjs', import.meta.url));
const packageJson = JSON.parse(readFileSync(
  new URL('../../package.json', import.meta.url),
  'utf8',
)) as { version: string };

test('accepts only the exact stable package version release tag', () => {
  const accepted = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { ...process.env, RELEASE_TAG: `v${packageJson.version}` },
  });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, new RegExp(`package version ${packageJson.version}`));

  const rejected = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { ...process.env, RELEASE_TAG: `v${packageJson.version}.1` },
  });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /does not match package version/);

  const missing = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: Object.fromEntries(
      Object.entries(process.env).filter(([name]) => name !== 'RELEASE_TAG'),
    ),
  });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /RELEASE_TAG is required/);
});
