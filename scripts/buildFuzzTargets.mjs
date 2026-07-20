import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = new URL('../', import.meta.url);

await run(process.execPath, [
  fileURLToPath(new URL('node_modules/tsdown/dist/run.mjs', root)),
  '--config',
  fileURLToPath(new URL('tsdown.fuzz.config.ts', root)),
]);

await writeCorpus('parser');
await writeCorpus('render');

async function writeCorpus(target) {
  const corpus = new URL(`.fuzz/corpus/${target}/`, root);
  await mkdir(corpus, { recursive: true });

  for (const [index, source] of seedSources().entries()) {
    await writeFile(
      new URL(`seed-${String(index).padStart(4, '0')}.txt`, corpus),
      source,
    );
  }
}

function seedSources() {
  const compatibility = JSON.parse(
    readFileSync(new URL('tests/compat/cases.json', root), 'utf8'),
  );
  const sources = [
    '',
    'plain text',
    '${{ value }}',
    '{{ value }}',
    '${{ text | identity }}',
    '${{ fail() }}',
    '${{ invalid() }}',
    '{% if flag %}${{ text }}{% endif %}',
    '{% for item in items %}${{ item }}{% endfor %}',
    '{% raw %}${{ ignored }}{% endraw %}',
    '{# ignored #}${{ object.key }}',
    '${{ constructor }}',
    '${{ value.__proto__ }}',
    '${{ r/a+/g }}',
  ];
  for (const compatibilityCase of compatibility.cases) {
    if (typeof compatibilityCase.template === 'string') {
      sources.push(compatibilityCase.template);
    }
  }
  return sources;
}
