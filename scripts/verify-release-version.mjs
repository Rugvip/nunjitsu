import { readFile } from 'node:fs/promises';

const packageJson = JSON.parse(await readFile(
  new URL('../package.json', import.meta.url),
  'utf8',
));
const version = packageJson.version;
if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
  throw new Error(`Release requires a stable package version, received ${String(version)}`);
}

const releaseTag = process.env.RELEASE_TAG;
if (!releaseTag) {
  throw new Error('RELEASE_TAG is required');
}
const expectedTag = `v${version}`;
if (releaseTag !== expectedTag) {
  throw new Error(`Release tag ${releaseTag} does not match package version ${expectedTag}`);
}

process.stdout.write(`Release tag ${releaseTag} matches package version ${version}\n`);
