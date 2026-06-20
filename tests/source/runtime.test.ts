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
  NunjitsuRenderError,
  TemplateLoaderError,
  type TemplateContext,
} from '../../src/index.ts';

test('renders through reusable shared-memory workers', async () => {
  const templates = { 'named.njk': 'Loaded {{ value }}' };
  const engine = await createEngine({
    loaders: [memoryLoader(templates)],
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
  await writeFile(join(root, 'page.njk'), 'File {{ value }}');
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
