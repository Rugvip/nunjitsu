import { execFileSync } from 'node:child_process';

const stableVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const zeroCommit = '0000000000000000000000000000000000000000';

function git(arguments_) {
  return execFileSync('git', arguments_, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function readVersion(commit) {
  let source;
  try {
    source = git(['show', `${commit}:package.json`]);
  } catch {
    return undefined;
  }

  let packageJson;
  try {
    packageJson = JSON.parse(source);
  } catch {
    throw new Error(`Commit ${commit} contains an invalid package.json`);
  }

  return packageJson.version;
}

const before = process.env.PUSH_BEFORE;
const after = process.env.PUSH_AFTER;

if (!before || !after) {
  throw new Error('PUSH_BEFORE and PUSH_AFTER are required');
}

if (before !== zeroCommit) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', before, after], {
      stdio: 'ignore',
    });
  } catch {
    throw new Error('Automatic releases require a fast-forward push');
  }
}

const range = before === zeroCommit ? after : `${before}..${after}`;
const commits = git(['rev-list', '--first-parent', '--reverse', range])
  .split('\n')
  .filter(Boolean);
const candidates = [];

for (const commit of commits) {
  const version = readVersion(commit);
  const parents = git(['rev-list', '--parents', '-n', '1', commit]).split(' ');
  const previousVersion = parents.length > 1
    ? readVersion(parents[1])
    : undefined;

  if (version === previousVersion) {
    continue;
  }

  if (typeof version !== 'string' || !stableVersionPattern.test(version)) {
    throw new Error(
      `Commit ${commit} changes package.json to unsupported version ${String(version)}`,
    );
  }

  candidates.push({
    commit,
    tag: `v${version}`,
    version,
  });
}

process.stdout.write(`${JSON.stringify(candidates)}\n`);
