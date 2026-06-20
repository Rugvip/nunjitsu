import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  createEngine,
  markSafe,
  memoryLoader,
  type TemplateContext,
  type TemplateValue,
} from '../../src/index.ts';

/** JSON representation accepted by the shared compatibility case decoder. */
type CompatibilityJson = null | boolean | number | string | CompatibilityJson[] | {
  [key: string]: CompatibilityJson;
};

/** One language-neutral render assertion. */
interface CompatibilityCase {
  id: string;
  template: string;
  templates?: Record<string, string>;
  context: Record<string, CompatibilityJson>;
  autoescape: boolean;
  expected: string;
}

/** Root compatibility case document. */
interface CompatibilityCases {
  schemaVersion: number;
  cases: CompatibilityCase[];
}

/** Upstream provenance attached to one parity entry. */
interface UpstreamReference {
  id: string;
  file: string;
  test: string;
}

/** One classified mapping from upstream behavior to shared cases. */
interface ManifestEntry {
  upstream: UpstreamReference;
  status: 'ported' | 'adapted' | 'not applicable' | 'partial';
  cases?: string[];
}

/** Partial manifest document expanded as upstream cases are adapted. */
interface CompatibilityManifest {
  schemaVersion: number;
  baseline: { commit: string };
  coverage: 'partial' | 'complete';
  entries: ManifestEntry[];
}

/** One immutable upstream Mocha-case inventory entry. */
interface InventoryEntry {
  id: string;
  file: string;
  testNameSource: string;
}

/** Complete upstream inventory document. */
interface UpstreamInventory {
  schemaVersion: number;
  baseline: { commit: string };
  entries: InventoryEntry[];
}

const baselineCommit = '86a77f49da4779d55414d8337e1a4d7ec7582da5';
const cases = await readJson<CompatibilityCases>('../compat/cases.json');
const manifest = await readJson<CompatibilityManifest>('../compat/manifest.json');
const inventory = await readJson<UpstreamInventory>('../compat/upstream-inventory.json');

test('shared compatibility corpus has attributed provenance and valid mappings', async () => {
  assert.equal(cases.schemaVersion, 1);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(inventory.schemaVersion, 1);
  assert.equal(manifest.baseline.commit, baselineCommit);
  assert.equal(inventory.baseline.commit, baselineCommit);
  assert.equal(inventory.entries.length, 364);

  const caseIds = new Set(cases.cases.map(entry => entry.id));
  assert.equal(caseIds.size, cases.cases.length);
  const classified = new Set<string>();
  for (const entry of manifest.entries) {
    assert.ok(!classified.has(entry.upstream.id), `Duplicate classification ${entry.upstream.id}`);
    classified.add(entry.upstream.id);
    assert.ok(
      inventory.entries.some(candidate =>
        candidate.id === entry.upstream.id &&
        candidate.file === entry.upstream.file &&
        candidate.testNameSource === entry.upstream.test
      ),
      `Missing upstream inventory entry for ${entry.upstream.file}: ${entry.upstream.test}`,
    );
    for (const caseId of entry.cases ?? []) {
      assert.ok(caseIds.has(caseId), `Manifest references missing case ${caseId}`);
    }
  }
  if (manifest.coverage === 'complete') {
    assert.ok(manifest.entries.every(entry => entry.status !== 'partial'));
    assert.equal(classified.size, inventory.entries.length);
    assert.deepEqual(classified, new Set(inventory.entries.map(entry => entry.id)));
  }

  const license = await readFile(new URL('../compat/upstream/LICENSE', import.meta.url), 'utf8');
  assert.match(license, /Copyright \(c\) 2012-2015, James Long/);
});

test('shared compatibility cases render through the TypeScript engine', async t => {
  for (const compatibilityCase of cases.cases) {
    await t.test(compatibilityCase.id, async () => {
      const engine = await createEngine({
        autoescape: compatibilityCase.autoescape,
        ...(compatibilityCase.templates
          ? { loaders: [memoryLoader(compatibilityCase.templates)] }
          : {}),
      });
      try {
        const context = decodeContext(compatibilityCase.context);
        assert.equal(
          await engine.render({ source: compatibilityCase.template }, context),
          compatibilityCase.expected,
        );
      } finally {
        await engine.dispose();
      }
    });
  }
});

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8')) as T;
}

function decodeContext(value: Record<string, CompatibilityJson>): TemplateContext {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, decodeValue(entry)]),
  );
}

function decodeValue(value: CompatibilityJson): TemplateValue {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(decodeValue);
  }
  if (value.$nunjitsu === 'safe' && typeof value.value === 'string') {
    return markSafe(value.value);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, decodeValue(entry)]),
  );
}
