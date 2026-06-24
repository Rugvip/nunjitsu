export async function getReleaseLine(changeset) {
  const [firstLine, ...remainingLines] = changeset.summary
    .split('\n')
    .map(line => line.trimEnd());
  const continuation = remainingLines.length === 0
    ? ''
    : `\n${remainingLines.map(line => `  ${line}`).join('\n')}`;

  return `- ${firstLine}${continuation}`;
}

export async function getDependencyReleaseLine(_changesets, dependenciesUpdated) {
  if (dependenciesUpdated.length === 0) {
    return '';
  }

  return [
    '- Updated dependencies:',
    ...dependenciesUpdated.map(
      dependency => `  - ${dependency.name}@${dependency.newVersion}`,
    ),
  ].join('\n');
}

export default Object.freeze({
  getDependencyReleaseLine,
  getReleaseLine,
});
