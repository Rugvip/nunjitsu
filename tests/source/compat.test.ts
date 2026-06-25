import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import nunjucks from 'nunjucks';

import { createTemplateRenderer, type TemplateContext } from '../../src/index.ts';

interface CompatibilityCase {
  id: string;
  template: string;
  context: TemplateContext;
  expected: string;
}

interface CompatibilityCases {
  schemaVersion: number;
  cases: CompatibilityCase[];
}

interface ManifestEntry {
  upstream: { id: string; file: string; test: string };
  status: 'ported' | 'adapted' | 'not applicable' | 'partial';
  cases?: string[];
  reason?: string;
}

interface CompatibilityManifest {
  schemaVersion: number;
  baseline: { commit: string };
  coverage: 'partial' | 'complete';
  entries: ManifestEntry[];
}

interface UpstreamInventory {
  schemaVersion: number;
  baseline: { commit: string };
  entries: Array<{ id: string; file: string; testNameSource: string }>;
}

interface SourceCoverageEntry {
  id: string;
  file: string;
  test: string;
  upstream?: string[];
  upstreamRange?: { file: string; start: number; end: number };
  statuses?: Array<ManifestEntry['status']>;
}

interface CompatibilityCoverage {
  schemaVersion: number;
  sourceTests: SourceCoverageEntry[];
}

const baselineCommit = '86a77f49da4779d55414d8337e1a4d7ec7582da5';
const cases = await readJson<CompatibilityCases>('../compat/cases.json');
const manifest = await readJson<CompatibilityManifest>('../compat/manifest.json');
const inventory = await readJson<UpstreamInventory>('../compat/upstream-inventory.json');
const coverage = await readJson<CompatibilityCoverage>('../compat/coverage.json');

test('compatibility corpus retains complete attributed provenance', async () => {
  assert.equal(cases.schemaVersion, 1);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(inventory.schemaVersion, 1);
  assert.equal(coverage.schemaVersion, 1);
  assert.equal(manifest.baseline.commit, baselineCommit);
  assert.equal(inventory.baseline.commit, baselineCommit);
  assert.equal(inventory.entries.length, 364);

  const caseIds = new Set(cases.cases.map(entry => entry.id));
  const classified = new Set<string>();
  const executableCoverage = new Set<string>();
  for (const entry of manifest.entries) {
    assert.ok(!classified.has(entry.upstream.id));
    classified.add(entry.upstream.id);
    assert.ok(inventory.entries.some(candidate =>
      candidate.id === entry.upstream.id &&
      candidate.file === entry.upstream.file &&
      candidate.testNameSource === entry.upstream.test
    ));
    for (const caseId of entry.cases ?? []) {
      assert.ok(caseIds.has(caseId), `Manifest references missing case ${caseId}`);
      executableCoverage.add(entry.upstream.id);
    }
    if (entry.status === 'adapted' || entry.status === 'not applicable') {
      assert.ok(entry.reason, `${entry.upstream.id} requires a classification reason`);
    }
  }

  const sourceCoverageIds = new Set<string>();
  for (const sourceTest of coverage.sourceTests) {
    assert.ok(!sourceCoverageIds.has(sourceTest.id), `Duplicate coverage id ${sourceTest.id}`);
    sourceCoverageIds.add(sourceTest.id);
    const source = await readFile(new URL(`../../${sourceTest.file}`, import.meta.url), 'utf8');
    assert.ok(
      source.includes(`test('${sourceTest.test}'`),
      `Missing source test ${sourceTest.file}: ${sourceTest.test}`,
    );
    const upstreamIds = sourceTest.upstream ?? rangeUpstreamIds(sourceTest, manifest.entries);
    assert.ok(upstreamIds.length > 0, `${sourceTest.id} does not select upstream cases`);
    for (const upstreamId of upstreamIds) {
      const entry = manifest.entries.find(candidate => candidate.upstream.id === upstreamId);
      assert.ok(entry, `${sourceTest.id} references missing upstream case ${upstreamId}`);
      assert.notEqual(entry.status, 'not applicable', `${upstreamId} cannot have executable coverage`);
      executableCoverage.add(upstreamId);
    }
  }
  assert.equal(manifest.coverage, 'complete');
  assert.ok(manifest.entries.every(entry => entry.status !== 'partial'));
  assert.equal(classified.size, inventory.entries.length);
  for (const entry of manifest.entries) {
    if (entry.status === 'ported' || entry.status === 'adapted') {
      assert.ok(
        executableCoverage.has(entry.upstream.id),
        `${entry.upstream.id} is ${entry.status} without executable coverage`,
      );
    }
  }

  const license = await readFile(new URL('../compat/upstream/LICENSE', import.meta.url), 'utf8');
  assert.match(license, /Copyright \(c\) 2012-2015, James Long/);
});

test('applicable upstream cases render synchronously in Cookiecutter mode', async t => {
  const applicable = cases.cases;
  assert.ok(applicable.length >= 60);
  const engine = createTemplateRenderer({ cookiecutterCompat: true });
  for (const compatibilityCase of applicable) {
    await t.test(compatibilityCase.id, () => {
      assert.equal(
        engine.render(compatibilityCase.template, compatibilityCase.context),
        compatibilityCase.expected,
      );
    });
  }
});

test('language-neutral cases match the pinned Nunjucks oracle', () => {
  const uninstall = (nunjucks.installJinjaCompat as unknown as () => () => void)();
  try {
    const environment = new nunjucks.Environment(null, {
      autoescape: false,
      tags: { variableStart: '{{', variableEnd: '}}' },
    });
    for (const compatibilityCase of cases.cases) {
      assert.equal(
        environment.renderString(compatibilityCase.template, compatibilityCase.context),
        compatibilityCase.expected,
        compatibilityCase.id,
      );
    }
  } finally {
    uninstall();
  }
});

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8')) as T;
}

function rangeUpstreamIds(
  coverageEntry: SourceCoverageEntry,
  manifestEntries: readonly ManifestEntry[],
): string[] {
  const range = coverageEntry.upstreamRange;
  assert.ok(range, `${coverageEntry.id} requires upstream or upstreamRange`);
  const ids: string[] = [];
  for (let ordinal = range.start; ordinal <= range.end; ordinal += 1) {
    const id = `${range.file}:${ordinal}`;
    const entry = manifestEntries.find(candidate => candidate.upstream.id === id);
    assert.ok(entry, `${coverageEntry.id} range references missing upstream case ${id}`);
    if (coverageEntry.statuses?.includes(entry.status)) {
      ids.push(id);
    }
  }
  return ids;
}
