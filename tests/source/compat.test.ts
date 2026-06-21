import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createEngine, type TemplateContext } from '../../src/index.ts';

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

const baselineCommit = '86a77f49da4779d55414d8337e1a4d7ec7582da5';
const cases = await readJson<CompatibilityCases>('../compat/cases.json');
const manifest = await readJson<CompatibilityManifest>('../compat/manifest.json');
const inventory = await readJson<UpstreamInventory>('../compat/upstream-inventory.json');

test('compatibility corpus retains complete attributed provenance', async () => {
  assert.equal(cases.schemaVersion, 1);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(inventory.schemaVersion, 1);
  assert.equal(manifest.baseline.commit, baselineCommit);
  assert.equal(inventory.baseline.commit, baselineCommit);
  assert.equal(inventory.entries.length, 364);

  const caseIds = new Set(cases.cases.map(entry => entry.id));
  const classified = new Set<string>();
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
    }
  }
  assert.equal(manifest.coverage, 'complete');
  assert.ok(manifest.entries.every(entry => entry.status !== 'partial'));
  assert.equal(classified.size, inventory.entries.length);

  const license = await readFile(new URL('../compat/upstream/LICENSE', import.meta.url), 'utf8');
  assert.match(license, /Copyright \(c\) 2012-2015, James Long/);
});

test('applicable upstream cases render synchronously in Cookiecutter mode', t => {
  const applicable = cases.cases;
  assert.ok(applicable.length >= 60);
  const engine = createEngine({ cookiecutterCompat: true });
  for (const compatibilityCase of applicable) {
    void t.test(compatibilityCase.id, () => {
      assert.equal(
        engine.render(compatibilityCase.template, compatibilityCase.context),
        compatibilityCase.expected,
      );
    });
  }
});

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8')) as T;
}
