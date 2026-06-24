const repository = process.argv[2];
const tag = process.argv[3];

if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
  throw new Error('A valid GitHub owner/repository is required');
}

const tagMatch = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(tag ?? '');
if (!tagMatch) {
  throw new Error('A stable v<version> release tag is required');
}

const version = tagMatch[1];
const changelogAnchor = version.replaceAll('.', '');
const changelogUrl = [
  `https://github.com/${repository}/blob/main/CHANGELOG.md`,
  `#${changelogAnchor}`,
].join('');

process.stdout.write(
  `See the [${version} changelog entry](${changelogUrl}) for the curated release highlights.\n\n` +
  'The generated notes below cover the complete commit range since the previous release.\n',
);
