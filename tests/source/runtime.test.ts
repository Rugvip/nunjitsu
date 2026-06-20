import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createEngine,
  fileSystemLoader,
  markSafe,
  memoryLoader,
  NunjitsuLimitError,
  NunjitsuRenderError,
  TemplateLoaderError,
  type TemplateContext,
  type TemplateLoader,
} from '../../src/index.ts';

test('renders through reusable shared-memory workers', async () => {
  const templates = {
    'named.njk': 'Loaded {{ value }}',
    'include.njk': 'Before {% include "partial.njk" %} after',
    'partial.njk': 'partial {{ value }} {% include \'nested.njk\' %}',
    'nested.njk': 'nested',
    'repeat.njk': '{% include "nested.njk" %}{% include "nested.njk" %}',
    'cycle-a.njk': '{% include "cycle-b.njk" %}',
    'cycle-b.njk': '{% include "cycle-a.njk" %}',
    'missing-include.njk': '{% include "absent.njk" %}',
  };
  const ownedTemplates = memoryLoader(templates);
  let nestedLoads = 0;
  const countingLoader: TemplateLoader = {
    async load(name, signal) {
      if (name === 'nested.njk') {
        nestedLoads += 1;
      }
      return await ownedTemplates.load(name, signal);
    },
  };
  const engine = await createEngine({
    loaders: [countingLoader],
    workerPool: { minWorkers: 1, maxWorkers: 2 },
  });
  templates['named.njk'] = 'mutated';

  try {
    const [greeting, staticText, missingValue] = await Promise.all([
      engine.render({ source: 'Hello {{ name }}!' }, { name: 'Nunjitsu' }),
      engine.render({ source: 'No interpolation' }),
      engine.render({ source: 'Missing: {{ value }}.' }),
    ]);
    assert.equal(greeting, 'Hello Nunjitsu!');
    assert.equal(staticText, 'No interpolation');
    assert.equal(missingValue, 'Missing: .');
    assert.equal(
      await engine.render({ name: 'named.njk' }, { value: 'from memory' }),
      'Loaded from memory',
    );
    assert.equal(
      await engine.render({ name: 'include.njk' }, { value: 'works' }),
      'Before partial works nested after',
    );
    nestedLoads = 0;
    assert.equal(await engine.render({ name: 'repeat.njk' }), 'nestednested');
    assert.equal(nestedLoads, 1);
    await assert.rejects(
      engine.render({ name: 'cycle-a.njk' }),
      error => error instanceof NunjitsuRenderError && error.code === 6,
    );
    assert.equal(await engine.render({ source: 'Clean after include cycle' }), 'Clean after include cycle');
    await assert.rejects(
      engine.render({ name: 'missing-include.njk' }),
      error => error instanceof TemplateLoaderError && /not found/.test(error.message),
    );
    assert.equal(
      await engine.render({ source: 'Clean after loader failure' }),
      'Clean after loader failure',
    );
    await assert.rejects(
      engine.render({ name: 'missing.njk' }),
      error => error instanceof TemplateLoaderError && /not found/.test(error.message),
    );

    assert.equal(
      await engine.render(
        { source: '{{ user.name }} {{ flags.0 }} {{ enabled }} {{ count }}{{ none }}' },
        {
          user: { name: 'nested' },
          flags: ['first', 'second'],
          enabled: true,
          count: 42.5,
          none: null,
        },
      ),
      'nested first true 42.5',
    );

    const stream = engine.renderStream({ source: '{{ value }}' }, { value: 'streamed' });
    assert.equal((await Array.fromAsync(stream)).join(''), 'streamed');

    await assert.rejects(
      engine.render({ source: '{{ unclosed' }),
      (error: unknown) => error instanceof NunjitsuRenderError && error.code === 3,
    );

    assert.equal(
      await engine.render({ source: 'Clean after failure: {{ ok }}' }, { ok: 'yes' }),
      'Clean after failure: yes',
    );

    const withGetter = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get: () => 'not evaluated',
    });
    await assert.rejects(
      engine.render({ source: '{{ secret }}' }, withGetter),
      /cannot contain accessors/,
    );

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await assert.rejects(
      engine.render({ source: '{{ self }}' }, cyclic as unknown as TemplateContext),
      /Cyclic template values/,
    );
  } finally {
    await engine.dispose();
  }

  await assert.rejects(engine.render({ source: 'disposed' }), /disposed/);
});

test('filesystem loading stays within explicit canonical roots', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'nunjitsu-'));
  const root = join(sandbox, 'templates');
  const secret = join(sandbox, 'secret.njk');
  await mkdir(root);
  await writeFile(join(root, 'page.njk'), 'File {% include "partial.njk" %}');
  await writeFile(join(root, 'partial.njk'), '{{ value }}');
  await writeFile(secret, 'secret');

  const engine = await createEngine({
    loaders: [fileSystemLoader({ roots: [root] })],
  });
  try {
    assert.equal(
      await engine.render({ name: 'page.njk' }, { value: 'works' }),
      'File works',
    );
    await assert.rejects(engine.render({ name: '../secret.njk' }), /escapes its configured root/);

    if (process.platform !== 'win32') {
      await symlink(secret, join(root, 'link.njk'));
      await assert.rejects(engine.render({ name: 'link.njk' }), /symlink escapes/);
    }
  } finally {
    await engine.dispose();
    await rm(sandbox, { force: true, recursive: true });
  }
});

test('autoescaping requires an explicit safe string to bypass', async () => {
  const engine = await createEngine({ autoescape: true });
  try {
    assert.equal(
      await engine.render(
        { source: '<p>{{ unsafe }} {{ safe }}</p>' },
        {
          unsafe: '<script>"alert" & \'escape\'</script>',
          safe: markSafe('<strong>trusted</strong>'),
        },
      ),
      '<p>&lt;script&gt;&quot;alert&quot; &amp; &#39;escape&#39;&lt;/script&gt; <strong>trusted</strong></p>',
    );
    assert.equal(
      await engine.render({ source: '<b>{{ value }}</b>' }, { value: false }),
      '<b>false</b>',
    );
  } finally {
    await engine.dispose();
  }
});

test('cancels a render while its worker is suspended on an include loader', async () => {
  let markLoadStarted: (() => void) | undefined;
  const loadStarted = new Promise<void>(resolve => {
    markLoadStarted = resolve;
  });
  const delayedLoader: TemplateLoader = {
    async load(name, signal) {
      if (name !== 'delayed.njk') {
        return null;
      }
      markLoadStarted?.();
      return await new Promise<never>((_resolve, reject) => {
        const rejectAborted = () => {
          const error = new Error('delayed loader aborted');
          error.name = 'AbortError';
          reject(error);
        };
        if (signal?.aborted) {
          rejectAborted();
        } else {
          signal?.addEventListener('abort', rejectAborted, { once: true });
        }
      });
    },
  };
  const engine = await createEngine({
    loaders: [
      memoryLoader({ 'entry.njk': 'before {% include "delayed.njk" %} after' }),
      delayedLoader,
    ],
  });
  try {
    const controller = new AbortController();
    const rendering = engine.render({ name: 'entry.njk' }, {}, { signal: controller.signal });
    await loadStarted;
    controller.abort();
    await assert.rejects(rendering, error => error instanceof Error && error.name === 'AbortError');
    assert.equal(await engine.render({ source: 'clean' }), 'clean');
  } finally {
    await engine.dispose();
  }
});

test('enforces finite per-render limits and permits explicit unlimited values', async () => {
  const engine = await createEngine({
    loaders: [
      memoryLoader({
        'entry.njk': 'before {% include "partial.njk" %} after',
        'partial.njk': 'partial',
      }),
    ],
  });
  try {
    for (const [template, limits] of [
      [{ source: 'output' }, { outputBytes: 3 }],
      [{ source: 'work' }, { workUnits: 1 }],
      [{ source: '{{ value }}' }, { arenaBytes: 64 }],
      [{ name: 'entry.njk' }, { includeDepth: 1 }],
      [{ name: 'entry.njk' }, { loaderCalls: 1 }],
    ] as const) {
      await assert.rejects(
        engine.render(template, { value: 'large input' }, { limits }),
        error => error instanceof NunjitsuLimitError,
      );
      assert.equal(await engine.render({ source: 'clean' }), 'clean');
    }

    assert.equal(
      await engine.render(
        { source: 'unlimited output' },
        {},
        {
          limits: {
            workUnits: Number.POSITIVE_INFINITY,
            outputBytes: Number.POSITIVE_INFINITY,
            arenaBytes: Number.POSITIVE_INFINITY,
          },
        },
      ),
      'unlimited output',
    );
  } finally {
    await engine.dispose();
  }
});
