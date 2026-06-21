import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  createEngine,
  fileSystemLoader,
  markSafe,
  memoryLoader,
  NunjitsuLimitError,
  NunjitsuRenderError,
  TemplateLoaderError,
  TemplateNotFoundError,
  type TemplateContext,
  type TemplateLoader,
} from '../../src/index.ts';
import { createEngineWithRuntime } from '../../src/engine.ts';
import { decodeLoadRequest } from '../../src/protocol.ts';

test('validates parent-aware loader request records at the Wasm boundary', () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const view = new DataView(memory.buffer);
  const bytes = new Uint8Array(memory.buffer);
  const encoder = new TextEncoder();
  const nameOffset = 64;
  const fromOffset = 96;
  const requestOffset = 160;
  const writeString = (offset: number, value: string) => {
    const encoded = encoder.encode(value);
    view.setUint32(offset, 2, true);
    view.setUint32(offset + 4, encoded.byteLength, true);
    bytes.set(encoded, offset + 8);
  };

  writeString(nameOffset, './partial.njk');
  writeString(fromOffset, 'memory:pages%2Fentry.njk');
  view.setUint32(requestOffset, 34, true);
  view.setUint32(requestOffset + 4, 8, true);
  view.setUint32(requestOffset + 8, nameOffset, true);
  view.setUint32(requestOffset + 12, fromOffset, true);

  assert.deepEqual(decodeLoadRequest(memory, requestOffset, 8), {
    name: './partial.njk',
    from: 'memory:pages%2Fentry.njk',
  });
  view.setUint32(requestOffset + 12, 0, true);
  assert.deepEqual(decodeLoadRequest(memory, requestOffset, 8), {
    name: './partial.njk',
  });

  const fixedLayout = {
    slotOffset: 512,
    slotCapacity: 2,
    sourceOffset: 1_024,
    sourceCapacity: 1,
    valueOffset: 1_088,
    valueCapacity: 1,
    memberOffset: 1_152,
    memberCapacity: 1,
    stringOperationOffset: 1_216,
    stringOperationCapacity: 1,
    outputRangeOffset: 1_280,
    outputRangeCapacity: 1,
    scratchOffset: 1_344,
    scratchCapacity: 1,
  };
  const fixedCursors = { slots: 2, sources: 0, values: 0, members: 0, strings: 0 };
  const requestSlot = fixedLayout.slotOffset + 72;
  view.setUint32(requestSlot, 34 | (8 << 8), true);
  view.setUint32(requestSlot + 4, nameOffset, true);
  view.setUint32(requestSlot + 8, fromOffset, true);
  assert.deepEqual(decodeLoadRequest(memory, 1, 8, fixedLayout, fixedCursors), {
    name: './partial.njk',
    from: 'memory:pages%2Fentry.njk',
  });

  assert.throws(() => decodeLoadRequest(memory, requestOffset, 4), /record envelope/);
  view.setUint32(requestOffset, 2, true);
  assert.throws(() => decodeLoadRequest(memory, requestOffset, 8), /record envelope/);
  view.setUint32(requestOffset, 34, true);
  view.setUint32(requestOffset + 12, memory.buffer.byteLength, true);
  assert.throws(() => decodeLoadRequest(memory, requestOffset, 8), /out-of-bounds record/);
});

test('allocates immutable worker memory capacities without growing at render time', async () => {
  await assert.rejects(
    createEngine({ memory: { slots: 0 } }),
    error => error instanceof RangeError && /memory\.slots/.test(error.message),
  );
  await assert.rejects(
    createEngine({ memory: { sourceCodeUnits: 0x1_0000_0000 } }),
    error => error instanceof RangeError && /memory\.sourceCodeUnits/.test(error.message),
  );

  const engine = await createEngine({
    memory: {
      slots: 8,
      sourceCodeUnits: 64,
      valueCodeUnits: 64,
      members: 10,
      stringOperations: 1,
      stringQueries: 1,
      outputRanges: 1,
    },
  });
  try {
    await assert.rejects(
      engine.render({ source: 'x'.repeat(20_000_000) }),
      error => error instanceof NunjitsuLimitError,
    );
    assert.equal(await engine.render({ source: 'clean' }), 'clean');
    await assert.rejects(
      engine.render({ source: '{% for value in [1] %}{{ value }}{% endfor %}' }),
      error => error instanceof NunjitsuLimitError,
    );
    assert.equal(await engine.render({ source: 'reset' }), 'reset');
  } finally {
    await engine.dispose();
  }

  const memberLimitedEngine = await createEngine({
    memory: {
      slots: 64,
      sourceCodeUnits: 64,
      valueCodeUnits: 256,
      members: 10,
      stringOperations: 1,
      stringQueries: 1,
      outputRanges: 1,
    },
  });
  try {
    await assert.rejects(
      memberLimitedEngine.render({
        source: '{% for value in [1] %}{{ value }}{% endfor %}',
      }),
      error => error instanceof NunjitsuLimitError,
    );
    assert.equal(await memberLimitedEngine.render({ source: 'reset' }), 'reset');
  } finally {
    await memberLimitedEngine.dispose();
  }
});

test('renders through reusable shared-memory workers', async () => {
  const templates = {
    'named.njk': 'Loaded {{ value }}',
    'include.njk': 'Before {% include "partial.njk" %} after',
    'partial.njk': 'partial {{ value }} {% include \'nested.njk\' %}',
    'nested.njk': 'nested',
    'repeat.njk': '{% include "nested.njk" %}{% include "nested.njk" %}',
    'dynamic.njk': [
      '{% set chosen = "nested.njk" %}',
      '{% include chosen %}|',
      '{% include selection.name %}|',
      '{% include "NESTED.NJK" | lower %}',
    ].join(''),
    'cycle-a.njk': '{% include "cycle-b.njk" %}',
    'cycle-b.njk': '{% include "cycle-a.njk" %}',
    'missing-include.njk': '{% include "absent.njk" %}',
    'broken-import.njk': '{% from "doesnotexist" import foo %}',
    'optional-include.njk': 'before{% include "absent.njk" ignore missing %}after',
    'leaf.njk': 'FooInclude ',
    'many-includes.njk': Array.from(
      { length: 130 },
      () => '{% include "leaf.njk" %}\n',
    ).join(''),
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
    const prototypeFree = Object.create(null) as Record<string, unknown>;
    prototypeFree.foo = Object.assign(Object.create(null) as Record<string, string>, { bar: 'baz' });
    assert.equal(
      await engine.render({ source: '{{ foo.bar }}' }, prototypeFree as TemplateContext),
      'baz',
    );
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
    assert.equal(
      await engine.render({ name: 'many-includes.njk' }),
      'FooInclude \n'.repeat(130),
    );
    assert.equal(
      await engine.render({ name: 'dynamic.njk' }, { selection: { name: 'nested.njk' } }),
      'nested|nested|nested',
    );
    await assert.rejects(
      engine.render({ name: 'cycle-a.njk' }),
      error => error instanceof NunjitsuRenderError && error.code === 6,
    );
    assert.equal(await engine.render({ source: 'Clean after include cycle' }), 'Clean after include cycle');
    await assert.rejects(
      engine.render({ name: 'missing-include.njk' }),
      error => error instanceof TemplateNotFoundError && /not found/.test(error.message),
    );
    await assert.rejects(
      engine.render({ source: '{% include "broken-import.njk" %}' }),
      error => error instanceof TemplateNotFoundError,
    );
    assert.equal(await engine.render({ name: 'optional-include.njk' }), 'beforeafter');
    assert.equal(
      await engine.render({ source: 'Clean after loader failure' }),
      'Clean after loader failure',
    );
    await assert.rejects(
      engine.render({ name: 'missing.njk' }),
      error => error instanceof TemplateNotFoundError && /not found/.test(error.message),
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

test('compiles Wasm once before growing the lazy worker pool', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'nunjitsu-wasm-'));
  const copiedWasm = join(sandbox, 'nunjitsu_engine.wasm');
  await copyFile(
    new URL('../../rust/target/wasm32-unknown-unknown/release/nunjitsu_engine.wasm', import.meta.url),
    copiedWasm,
  );
  let markLoadStarted: (() => void) | undefined;
  const loadStarted = new Promise<void>(resolve => {
    markLoadStarted = resolve;
  });
  let releaseLoad: (() => void) | undefined;
  const loadReleased = new Promise<void>(resolve => {
    releaseLoad = resolve;
  });
  const engine = await createEngineWithRuntime(
    {
      workerUrl: new URL('../../src/worker.ts', import.meta.url),
      wasmUrl: pathToFileURL(copiedWasm),
    },
    {
      loaders: [{
        async load(name) {
          if (name !== 'held.njk') {
            return null;
          }
          markLoadStarted?.();
          await loadReleased;
          return { source: 'held', canonicalName: 'memory:held.njk' };
        },
      }],
      workerPool: { minWorkers: 1, maxWorkers: 2 },
    },
  );

  try {
    await rm(copiedWasm);
    const heldRender = engine.render({ source: '{% include "held.njk" %}' });
    await loadStarted;
    assert.equal(await engine.render({ source: 'lazy worker' }), 'lazy worker');
    releaseLoad?.();
    assert.equal(await heldRender, 'held');
  } finally {
    releaseLoad?.();
    await engine.dispose();
    await rm(sandbox, { force: true, recursive: true });
  }
});

test('streams evaluator chunks with backpressure and preserves partial failure semantics', async () => {
  let includeLoads = 0;
  let markIncludeStarted: (() => void) | undefined;
  const includeStarted = new Promise<void>(resolve => {
    markIncludeStarted = resolve;
  });
  const engine = await createEngine({
    autoescape: false,
    loaders: [{
      async load(name) {
        if (name !== 'partial.njk') {
          return null;
        }
        includeLoads += 1;
        markIncludeStarted?.();
        return { source: 'partial', canonicalName: 'memory:partial.njk' };
      },
    }],
    workerPool: { minWorkers: 1, maxWorkers: 1 },
  });

  try {
    const reader = engine.renderStream(
      { source: 'first{{ value }}{% include "partial.njk" %}last' },
      { value: 'second' },
    ).getReader();
    assert.deepEqual(await reader.read(), { value: 'first', done: false });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(includeLoads, 0);

    assert.deepEqual(await reader.read(), { value: 'second', done: false });
    await includeStarted;
    const remaining: string[] = [];
    for (;;) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      remaining.push(result.value);
    }
    assert.deepEqual(remaining, ['partial', 'last']);

    const largeValue = `${'a'.repeat(65_535)}💥${'b'.repeat(65_536)}`;
    const largeChunks: string[] = [];
    for await (const chunk of engine.renderStream({ source: '{{ value }}' }, { value: largeValue })) {
      largeChunks.push(chunk);
    }
    assert.equal(largeChunks.join(''), largeValue);
    assert.ok(largeChunks.length >= 3);
    assert.ok(largeChunks.every(chunk => Buffer.byteLength(chunk) <= 64 * 1024));

    assert.equal(
      (await Array.fromAsync(
        engine.renderStream({ source: 'before{% include "absent.njk" ignore missing %}after' }),
      )).join(''),
      'beforeafter',
    );

    const invalid = engine.renderStream({ source: 'visible{{ unclosed' }).getReader();
    assert.deepEqual(await invalid.read(), { value: 'visible', done: false });
    await assert.rejects(
      invalid.read(),
      error => error instanceof NunjitsuRenderError && error.code === 3,
    );

    const limited = engine.renderStream(
      { source: 'ab{{ value }}' },
      { value: 'cd' },
      { limits: { outputBytes: 3 } },
    ).getReader();
    assert.deepEqual(await limited.read(), { value: 'ab', done: false });
    await assert.rejects(limited.read(), error => error instanceof NunjitsuLimitError);
  } finally {
    await engine.dispose();
  }

});

test('omits comments and preserves raw and verbatim regions', async () => {
  const engine = await createEngine();
  try {
    assert.equal(
      await engine.render({
        source: [
          'before',
          '{# {{ hidden }} {% unknown %} #}',
          '{% raw %}{{ raw }} {% unknown %}{% endraw %}',
          '{% verbatim %}{# literal #}{% endverbatim %}',
          'after',
        ].join(''),
      }),
      'before{{ raw }} {% unknown %}{# literal #}after',
    );
    assert.equal(
      (await Array.fromAsync(engine.renderStream({
        source: 'a{# omit #}{% raw %}{{ untouched }}{% endraw %}b',
      }))).join(''),
      'a{{ untouched }}b',
    );
    await assert.rejects(
      engine.render({ source: '{# unclosed' }),
      error => error instanceof NunjitsuRenderError && error.code === 5,
    );
    await assert.rejects(
      engine.render({ source: '{% raw %}unclosed' }),
      error => error instanceof NunjitsuRenderError && error.code === 5,
    );
  } finally {
    await engine.dispose();
  }
});

test('applies explicit and environment whitespace controls', async () => {
  const engine = await createEngine();
  try {
    assert.equal(
      await engine.render(
        { source: 'Well, {{- greeting -}} my friend' },
        { greeting: ' hello, ' },
      ),
      'Well, hello, my friend',
    );
    assert.equal(
      await engine.render({ source: 'hello \n{#- comment -#} \n world' }),
      'helloworld',
    );
    assert.equal(
      await engine.render({ source: '  {% if true -%}\n  hi \n{%- endif %}  ' }),
      '  hi  ',
    );
    assert.equal(
      await engine.render({ source: 'a {% raw -%}\n {{ value }} \n{%- endraw %} b' }),
      'a {{ value }} b',
    );
  } finally {
    await engine.dispose();
  }

  const configured = await createEngine({ trimBlocks: true, lstripBlocks: true });
  try {
    assert.equal(
      await configured.render({
        source: 'test\n {% if true %}\n  foo\n {% endif %}\n</div>',
      }),
      'test\n  foo\n</div>',
    );
    assert.equal(
      await configured.render({
        source: 'test\r\n {% if true %}\r\n  foo\r\n {% endif %}\r\n</div>',
      }),
      'test\r\n  foo\r\n</div>',
    );
    assert.equal(
      await configured.render({
        source: '  {% if true %}\rfoo\r\n{% endif %}\r',
      }),
      '\rfoo\r\n\r',
    );
    assert.equal(
      await configured.render({
        source: '   {% set a = 1 %} {% set b = 2 %}{{ a }}{{ b }}',
      }),
      ' 12',
    );
  } finally {
    await configured.dispose();
  }
});

test('resolves relative dependencies from each canonical parent identity', async () => {
  const ownedTemplates = memoryLoader({
    'layout/base.njk': '({% block body %}{% include "./base-partial.njk" %}{% endblock %})',
    'layout/base-partial.njk': 'base',
    'pages/child.njk': [
      '{% extends "../layout/base.njk" %}',
      '{% block body %}',
      '{% macro child() %}{% include "./child-partial.njk" %}{% endmacro %}',
      '{{ child() }}+{{ super() }}{% endblock %}',
    ].join(''),
    'pages/child-partial.njk': 'child',
    'widgets/local.njk': [
      '{% macro render_piece() %}{% include "./piece.njk" %}{% endmacro %}',
      '{{ render_piece() }}',
    ].join(''),
    'widgets/macros.njk': '{% macro render_piece() %}{% include "./piece.njk" %}{% endmacro %}',
    'widgets/piece.njk': 'piece',
    'pages/import.njk': [
      '{% import "../widgets/macros.njk" as widgets %}',
      '{{ widgets.render_piece() }}',
    ].join(''),
    'relative/cache.njk': [
      '{% include "./dir1/index.njk" %}|',
      '{% include "./dir2/index.njk" %}',
    ].join(''),
    'relative/dir1/index.njk': '{% include "./partial.njk" %}',
    'relative/dir1/partial.njk': 'one',
    'relative/dir2/index.njk': '{% include "./partial.njk" %}',
    'relative/dir2/partial.njk': 'two',
    'pages/cycle.njk': '{% include "./cycle.njk" %}',
    'pages/escape.njk': '{% include "../../outside.njk" %}',
  });
  const requests: Array<{ name: string; from: string | undefined }> = [];
  const loader: TemplateLoader = {
    async load(name, signal, from) {
      requests.push({ name, from });
      return await ownedTemplates.load(name, signal, from);
    },
  };
  const engine = await createEngine({ loaders: [loader] });

  try {
    assert.equal(await engine.render({ name: 'pages/child.njk' }), '(child+base)');
    assert.equal(await engine.render({ name: 'widgets/local.njk' }), 'piece');
    assert.equal(await engine.render({ name: 'pages/import.njk' }), 'piece');
    assert.equal(await engine.render({ name: 'relative/cache.njk' }), 'one|two');
    assert.equal(
      await engine.render({
        source: '{% include "./widgets/piece.njk" %}',
        canonicalName: 'memory:entry.njk',
      }),
      'piece',
    );

    assert.ok(requests.some(request =>
      request.name === './child-partial.njk' && request.from === 'memory:pages%2Fchild.njk'
    ));
    assert.ok(requests.some(request =>
      request.name === './base-partial.njk' && request.from === 'memory:layout%2Fbase.njk'
    ));
    assert.ok(requests.some(request =>
      request.name === './piece.njk' && request.from === 'memory:widgets%2Fmacros.njk'
    ));

    await assert.rejects(
      engine.render({ name: 'pages/cycle.njk' }),
      error => error instanceof NunjitsuRenderError && error.code === 6,
    );
    await assert.rejects(
      engine.render({ name: 'pages/escape.njk' }),
      error => error instanceof TemplateLoaderError && /escapes the memory namespace/.test(error.message),
    );
    await assert.rejects(
      engine.render({ source: 'invalid', canonicalName: '' }),
      /canonicalName must be a non-empty string/,
    );
  } finally {
    await engine.dispose();
  }
});

test('uses an ordered async loader chain and recovers from loader failures', async () => {
  const requests: string[] = [];
  const loaderFailure = new Error('loader failed');
  const engine = await createEngine({
    loaders: [
      {
        async load(name) {
          requests.push(`first:${name}`);
          return null;
        },
      },
      {
        async load(name, signal) {
          requests.push(`second:${name}`);
          assert.ok(signal && !signal.aborted);
          await new Promise<void>(resolve => setImmediate(resolve));
          if (name === 'fake.njk') {
            return { canonicalName: 'custom:fake.njk', source: 'Hello World' };
          }
          if (name === 'package/template.njk') {
            return { canonicalName: 'custom:package/template.njk', source: '{{ value }}' };
          }
          if (name === 'broken.njk') {
            throw loaderFailure;
          }
          return null;
        },
      },
    ],
    workerPool: { minWorkers: 1, maxWorkers: 1 },
  });

  try {
    assert.equal(await engine.render({ name: 'fake.njk' }), 'Hello World');
    assert.equal(
      await engine.render({ source: '{% include "package/template.njk" %}' }, { value: 'loaded' }),
      'loaded',
    );
    await assert.rejects(
      engine.render({ source: '{% include "broken.njk" %}' }),
      error => error === loaderFailure,
    );
    assert.equal(await engine.render({ source: 'clean after loader error' }), 'clean after loader error');
    await assert.rejects(
      engine.render({ name: 'missing.njk' }),
      error => error instanceof TemplateNotFoundError,
    );
    assert.deepEqual(requests.slice(0, 2), ['first:fake.njk', 'second:fake.njk']);
    assert.ok(requests.includes('second:broken.njk'));
    assert.ok(requests.includes('second:missing.njk'));
  } finally {
    await engine.dispose();
  }
});

test('filesystem loading stays within explicit canonical roots', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'nunjitsu-'));
  const emptyRoot = join(sandbox, 'empty');
  const root = join(sandbox, 'templates');
  const secret = join(sandbox, 'secret.njk');
  await mkdir(emptyRoot);
  await mkdir(root);
  await mkdir(join(root, 'layout'));
  await mkdir(join(root, 'pages'));
  await writeFile(join(root, 'page.njk'), 'File {% include "partial.njk" %}');
  await writeFile(join(root, 'partial.njk'), '{{ value }}');
  await writeFile(
    join(root, 'layout', 'base.njk'),
    'Nested {% block body %}base{% endblock %}',
  );
  await writeFile(
    join(root, 'pages', 'child.njk'),
    '{% extends "../layout/base.njk" %}{% block body %}{% include "./partial.njk" %}{% endblock %}',
  );
  await writeFile(join(root, 'pages', 'partial.njk'), '{{ value }}');
  await writeFile(join(root, 'pages', 'escape.njk'), '{% include "../../secret.njk" %}');
  await writeFile(secret, 'secret');

  const engine = await createEngine({
    loaders: [fileSystemLoader({ roots: [emptyRoot, root] })],
  });
  try {
    assert.equal(
      await engine.render({ name: 'page.njk' }, { value: 'works' }),
      'File works',
    );
    assert.equal(
      await engine.render({ name: 'pages/child.njk' }, { value: 'relative' }),
      'Nested relative',
    );
    assert.equal(
      await engine.render({
        source: '{% extends "./pages/child.njk" %}',
        canonicalName: pathToFileURL(join(root, 'inline.njk')).href,
      }, { value: 'inline' }),
      'Nested inline',
    );
    await assert.rejects(engine.render({ name: '../secret.njk' }), /escapes its configured root/);
    await assert.rejects(
      engine.render({ name: 'pages/escape.njk' }),
      /escapes its configured root/,
    );
    await assert.rejects(
      engine.render({ source: '{% include "../secret.njk" ignore missing %}' }),
      error => error instanceof TemplateLoaderError && /escapes its configured root/.test(error.message),
    );

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

test('evaluates Rust-native filters and tests without host capability calls', async () => {
  const engine = await createEngine({ autoescape: true });
  try {
    assert.equal(
      await engine.render(
        {
          source: [
            '{{ unsafe | escape }}',
            '{{ safe | forceescape }}',
            '{{ "foo" | upper }}',
            '{{ "FOO" | lower }}',
            '{{ "fOO" | capitalize }}',
            '{{ missing | default("fallback") }}',
            '{{ false | default("fallback", true) }}',
            '{{ values | reverse | first }}',
            '{{ word | reverse }}',
            '{{ values | length }}',
          ].join('|'),
        },
        {
          unsafe: '<html>\\',
          safe: markSafe('<safe>'),
          values: ['a', 'b', 'c'],
          word: 'a💥b',
        },
      ),
      '&lt;html&gt;&#92;|&lt;safe&gt;|FOO|foo|Foo|fallback|fallback|c|b💥a|3',
    );
    assert.equal(
      await engine.render(
        {
          source: [
            '{{ missing is defined }}',
            '{{ missing is undefined }}',
            '{{ none is null }}',
            '{{ 3 is odd }}',
            '{{ 4 is even }}',
            '{{ "6" is divisibleby(3) }}',
            '{{ safe is escaped }}',
            '{{ values is iterable }}',
            '{{ record is mapping }}',
            '{{ "foo" is lower }}',
            '{{ 5 is greaterthan(4) }}',
          ].join('|'),
        },
        {
          safe: markSafe('<safe>'),
          values: [],
          record: {},
        },
      ),
      'false|true|true|true|true|true|true|true|true|true|true',
    );
    assert.equal(
      await engine.render({
        source: '{{ (3 + 4 == 7) }}|{% if 1 < 2 + 3 %}yes{% endif %}',
      }),
      'true|yes',
    );
    assert.equal(
      await engine.render({
        source: '{{ "selected" if true else absent() }}|{{ absent() if false }}',
      }),
      'selected|',
    );
  } finally {
    await engine.dispose();
  }

  const overriding = await createEngine({
    filters: {
      upper() {
        return 'overridden';
      },
    },
  });
  try {
    assert.equal(await overriding.render({ source: '{{ "value" | upper }}' }), 'overridden');
  } finally {
    await overriding.dispose();
  }
});

test('matches scalar, numeric, and text filter edge semantics', async () => {
  const engine = await createEngine();
  const cases: readonly [string, TemplateContext, string][] = [
    ['{{ -3.456 | abs }}', {}, '3.456'],
    ['{{ "foo" | capitalize }}', {}, 'Foo'],
    ['{{ str | capitalize }}', { str: markSafe('foo') }, 'Foo'],
    ['{{ undefined | capitalize }}', {}, ''],
    ['{{ "fooo" | center }}', {}, `${' '.repeat(38)}fooo${' '.repeat(38)}`],
    ['{{ "foo" | center }}', {}, `${' '.repeat(38)}foo${' '.repeat(39)}`],
    ['{{ false | default("foo") }}', {}, 'false'],
    ['{{ false | default("foo", true) }}', {}, 'foo'],
    ['{{ foo | escape }}', { foo: ['<html>'] }, '&lt;html&gt;'],
    ['{{ "<html>" | escape | escape }}', {}, '&lt;html&gt;'],
    ['{{ "<html>" | safe | forceescape }}', {}, '&lt;html&gt;'],
    ['{{ "3.5" | float }}', {}, '3.5'],
    ['{{ "bob" | float("cat") }}', {}, 'cat'],
    ['{{ "3.5" | int }}', {}, '3'],
    ['{{ "0x4d32" | int(base=16) }}', {}, '19762'],
    ['{{ "011" | int(base=8) }}', {}, '9'],
    ['{{ "bob" | int("cat") }}', {}, 'cat'],
    ['{{ "one\ntwo\nthree" | indent(2, true) }}', {}, '  one\n  two\n  three'],
    ['{{ items | join(",", "name") }}', { items: [{ name: 'foo' }, { name: 'bar' }] }, 'foo,bar'],
    ['{{ str | nl2br }}', { str: markSafe('foo\r\nbar') }, 'foo<br />\nbar'],
    ['{{ "foo\nbar" | nl2br }}', {}, 'foo&lt;br /&gt;\nbar'],
    ['{{ "aaabbbccc" | replace("", ".") }}', {}, '.a.a.a.b.b.b.c.c.c.'],
    ['{{ "aaabbbbbccc" | replace("b", "y", 4) }}', {}, 'aaayyyybccc'],
    ['{{ "aaabbbbbccc" | replace("b", "", 4) }}', {}, 'aaabccc'],
    ['{{ 4.5 | round }}', {}, '5'],
    ['{{ 4.5 | round(0, "floor") }}', {}, '4'],
    ['{{ 4.12345 | round(4) }}', {}, '4.1235'],
    ['{{ items | sum }}', { items: [1, 2, 3] }, '6'],
    ['{{ items | sum("value", 10) }}', { items: [{ value: 1 }, { value: 2 }] }, '13'],
    ['{{ 1234 | string }}', {}, '1234'],
    ['{{ "  foo " | trim }}', {}, 'foo'],
    ['{{ "foo bar baz" | title }}', {}, 'Foo Bar Baz'],
    ['{{ "foo" | upper }}|{{ "FOO" | lower }}', {}, 'FOO|foo'],
    ['{{ "foo bar baz" | wordcount }}', {}, '3'],
    ['{{ null | wordcount }}', {}, ''],
    [
      '{% for a in [1,2,3,4,5,6]|batch(2) %}-{% for b in a %}{{ b }}{% endfor %}-{% endfor %}',
      {},
      '-12--34--56-',
    ],
    [
      '{% for item in items | dictsort %}{{ item[0] }}{% endfor %}',
      { items: { e: 1, d: 2, c: 3, a: 4, f: 5, b: 6 } },
      'abcdef',
    ],
    [
      '{% for item in items | dictsort(false, "value") %}{{ item[0] }}{% endfor %}',
      { items: { a: 6, b: 5, c: 1, d: 2 } },
      'cdba',
    ],
    ['{% for i in "foobar" | list %}{{ i }},{% endfor %}', {}, 'f,o,o,b,a,r,'],
    [
      '{% for pair in person | list %}{{ pair.key }}: {{ pair.value }} - {% endfor %}',
      { person: { name: 'Joe', age: 83 } },
      'name: Joe - age: 83 - ',
    ],
    [
      '{% for items in arr | slice(3) %}--{% for item in items %}{{ item }}{% endfor %}--{% endfor %}',
      { arr: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
      '--1234----567----8910--',
    ],
    ['{% for i in [3,5,2,1,4,6] | sort %}{{ i }}{% endfor %}', {}, '123456'],
    ['{% for i in [1,6,3,7] | sort(true) %}{{ i }}{% endfor %}', {}, '7631'],
    ['{% for i in ["fOo", "Foo"] | sort(false, true) %}{{ i }}{% endfor %}', {}, 'FoofOo'],
    [
      '{% for item in items | sort(false, false, "name") %}{{ item.name }}{% endfor %}',
      { items: [{ name: 'james' }, { name: 'fred' }, { name: 'john' }] },
      'fredjamesjohn',
    ],
    [
      '{% for item in items | sort(attribute="meta.age") %}{{ item.name }}{% endfor %}',
      {
        items: [
          { name: 'james', meta: { age: 25 } },
          { name: 'fred', meta: { age: 18 } },
          { name: 'john', meta: { age: 19 } },
        ],
      },
      'fredjohnjames',
    ],
    ['{{ [1,2,3] | length }}', {}, '3'],
    ['{{ missing | length }}', {}, '0'],
    ['{{ value | length }}', { value: 'blah' }, '4'],
    ['{{ value | length }}', { value: markSafe('<blah>') }, '6'],
    ['{{ undefined | length }}|{{ null | length }}', {}, '0|0'],
    ['{{ value | length }}', { value: {} }, '0'],
    ['{{ value | length }}', { value: { key: 'value' } }, '1'],
    ['{{ value | length }}', { value: { key: 'value', length: 5 } }, '2'],
    ['{{ value | length }}', { value: [0, 1] }, '2'],
    ['{{ value | length }}', { value: [0, , 2] }, '3'],
    ['{{ value | length }}', { value: new Array(0, 1) }, '2'],
    [
      '{% for type, items in items | groupby("type") %}:{{ type }}:{% for item in items %}{{ item.name }}{% endfor %}{% endfor %}',
      {
        items: [
          { name: 'james', type: 'green' },
          { name: 'john', type: 'blue' },
          { name: 'jim', type: 'blue' },
          { name: 'jessie', type: 'green' },
        ],
      },
      ':green:jamesjessie:blue:johnjim',
    ],
    [
      '{% for type, items in items | groupby("type") %}:{{ type }}:{% for item in items %}{{ item.name }}{% endfor %}{% endfor %}',
      {
        items: [
          { name: 'james', type: 'green' },
          { name: 'john', type: 'blue' },
          { name: 'jim', type: 'blue' },
          { name: 'jessie', color: 'green' },
        ],
      },
      ':green:james:blue:johnjim:undefined:jessie',
    ],
    [
      '{% for year, posts in posts | groupby("date.year") %}:{{ year }}:{% for post in posts %}{{ post.title }}{% endfor %}{% endfor %}',
      {
        posts: [
          { date: { year: 2019 }, title: 'Post 1' },
          { date: { year: 2018 }, title: 'Post 2' },
          { date: { year: 2019 }, title: 'Post 3' },
        ],
      },
      ':2018:Post 2:2019:Post 1Post 3',
    ],
    [
      '{% for year, posts in posts | groupby("date.year") %}:{{ year }}:{% for post in posts %}{{ post.title }}{% endfor %}{% endfor %}',
      {
        posts: [
          { date: { year: 2019 }, title: 'Post 1' },
          { date: { year: 2018 }, title: 'Post 2' },
          { meta: { month: 2 }, title: 'Post 3' },
        ],
      },
      ':2018:Post 2:2019:Post 1:undefined:Post 3',
    ],
    [
      '{% for type, items in items | groupby({}) %}:{{ type }}:{% for item in items %}{{ item.name }}{% endfor %}{% endfor %}',
      {
        items: [
          { name: 'james', type: 'green' },
          { name: 'john', type: 'blue' },
          { name: 'jim', type: 'blue' },
          { name: 'jessie', type: 'green' },
        ],
      },
      ':undefined:jamesjohnjimjessie',
    ],
    ['{{ numbers | reject("odd") | join }}', { numbers: [0, 1, 2, 3, 4, 5] }, '024'],
    ['{{ numbers | reject("even") | join }}', { numbers: [0, 1, 2, 3, 4, 5] }, '135'],
    [
      '{{ numbers | reject("divisibleby", 3) | join }}',
      { numbers: [0, 1, 2, 3, 4, 5] },
      '1245',
    ],
    ['{{ numbers | reject() | join }}', { numbers: [0, 1, 2, 3, 4, 5] }, '0'],
    ['{{ numbers | select("odd") | join }}', { numbers: [0, 1, 2, 3, 4, 5] }, '135'],
    ['{{ numbers | select("even") | join }}', { numbers: [0, 1, 2, 3, 4, 5] }, '024'],
    [
      '{{ numbers | select("divisibleby", 3) | join }}',
      { numbers: [0, 1, 2, 3, 4, 5] },
      '03',
    ],
    ['{{ numbers | select() | join }}', { numbers: [0, 1, 2, 3, 4, 5] }, '12345'],
    [
      '{{ foods | rejectattr("tasty") | length }}',
      { foods: [{ tasty: true }, { tasty: false }, { tasty: true }] },
      '1',
    ],
    [
      '{{ foods | selectattr("tasty") | length }}',
      { foods: [{ tasty: true }, { tasty: false }, { tasty: true }] },
      '2',
    ],
    [
      '{{ ["a", 1, {b: true}] | dump }}',
      {},
      '[&quot;a&quot;,1,{&quot;b&quot;:true}]',
    ],
    [
      '{{ ["a", 1, {b: true}] | dump(2) }}',
      {},
      '[\n  &quot;a&quot;,\n  1,\n  {\n    &quot;b&quot;: true\n  }\n]',
    ],
    [
      '{{ ["a", 1, {b: true}] | dump(4) }}',
      {},
      '[\n    &quot;a&quot;,\n    1,\n    {\n        &quot;b&quot;: true\n    }\n]',
    ],
    [
      '{{ ["a", 1, {b: true}] | dump("\t") }}',
      {},
      '[\n\t&quot;a&quot;,\n\t1,\n\t{\n\t\t&quot;b&quot;: true\n\t}\n]',
    ],
    ['{{ html | striptags }}', { html: '<foo>bar' }, 'bar'],
    [
      '{{ html | striptags }}',
      {
        html: '  <p>an  \n <a href="#">example</a> link</p>\n<p>to a webpage</p> <!-- <p>and some comments</p> -->',
      },
      'an example link to a webpage',
    ],
    ['{{ undefined | striptags }}|{{ null | striptags }}', {}, '|'],
    [
      '{{ html | striptags(true) }}',
      {
        html: '<div>\n  row1\nrow2  \n  <strong>row3</strong>\n</div>\n\n HEADER \n\n<ul>\n  <li>option  1</li>\n<li>option  2</li>\n</ul>',
      },
      'row1\nrow2\nrow3\n\nHEADER\n\noption 1\noption 2',
    ],
    ['{{ "foo bar" | truncate(3) }}', {}, 'foo...'],
    ['{{ "foo bar baz" | truncate(6) }}', {}, 'foo...'],
    ['{{ "foo bar baz" | truncate(7) }}', {}, 'foo bar...'],
    ['{{ "foo bar baz" | truncate(5, true) }}', {}, 'foo b...'],
    ['{{ "foo bar baz" | truncate(6, true, "?") }}', {}, 'foo ba?'],
    ['{{ undefined | truncate(3) }}|{{ null | truncate(3) }}', {}, '|'],
    ['{{ "&" | urlencode }}', {}, '%26'],
    ['{{ value | urlencode | safe }}', { value: [[1, 2], ['&1', '&2']] }, '1=2&%261=%262'],
    ['{{ value | urlencode | safe }}', { value: { 1: 2, '&1': '&2' } }, '1=2&%261=%262'],
    ['{{ 123456 | replace("4", ".") }}', {}, '123.56'],
    ['{{ 12345.6 | replace(4, ".") }}', {}, '123.5.6'],
    ['{{ 12345.6 | replace(4, 7) }}', {}, '12375.6'],
    ['{{ 123450.6 | replace(0, 7) }}', {}, '123457.6'],
    ['{{ "aaabbbccc" | replace(null, ".") }}', {}, 'aaabbbccc'],
    ['{{ "aaabbbccc" | replace(undefined, ".") }}', {}, 'aaabbbccc'],
    ['{{ "aaabbbccc" | replace({}, ".") }}', {}, 'aaabbbccc'],
    ['{{ "aaabbbccc" | replace(true, ".") }}', {}, 'aaabbbccc'],
    ['{{ "aaabbbccc" | replace(false, ".") }}', {}, 'aaabbbccc'],
    ['{{ "aaabbbccc" | replace(["wrong"], ".") }}', {}, 'aaabbbccc'],
    ['{{ "aaabbbccc" | replace("a", "x") }}', {}, 'xxxbbbccc'],
    ['{{ "aaabbbccc" | replace("a", "x", 2) }}', {}, 'xxabbbccc'],
    ['{{ "aaabbbbbccc" | replace("", "") }}', {}, 'aaabbbbbccc'],
    ['{{ "aaabbbbbccc" | replace("b", "") }}', {}, 'aaaccc'],
    ['{{ "aaabbbbbccc" | replace("ab", "y", 4) }}', {}, 'aaybbbbccc'],
    ['{{ "aaabbbbbccc" | replace("d", "y", 4) }}', {}, 'aaabbbbbccc'],
    ['{{ "aaabbcccbbb" | replace("b", "y", 4) }}', {}, 'aaayycccyyb'],
    ['{{ undefined | replace("b", "y", 4) }}', {}, ''],
    ['{{ null | replace("b", "y", 4) }}', {}, ''],
    ['{{ {} | replace("b", "y", 4) }}', {}, '[object Object]'],
    ['{{ [] | replace("b", "y", 4) }}', {}, ''],
    ['{{ true | replace("rue", "afafasf", 4) }}', {}, 'true'],
    ['{{ false | replace("rue", "afafasf", 4) }}', {}, 'false'],
    ['{{ "<img src=" | replace("<img", "<img alt=val") | safe }}', {}, '<img alt=val src='],
    [
      '{{ "<img src=\\"http://www.example.com\\" />" | replace("<img", "replacement text") | safe }}',
      {},
      'replacement text src="http://www.example.com" />',
    ],
    ['{{ "aabbbb" | replace(r/ab{2}/, "z") }}', {}, 'azbb'],
    ['{{ "aaaAAA" | replace(r/a/i, "z") }}', {}, 'zaaAAA'],
    ['{{ "aaaAAA" | replace(r/a/g, "z") }}', {}, 'zzzAAA'],
    ['{{ "aaaAAA" | replace(r/a/gi, "z") }}', {}, 'zzzzzz'],
    [
      '{{ "abc123" | replace(r/([a-z]+)([0-9]+)/, "$2-$1") }}',
      {},
      '123-abc',
    ],
    ['{{ value | replace("a", "x") }}', { value: markSafe('aaabbbccc') }, 'xxxbbbccc'],
    [
      '{{ "foo http://www.example.com/ bar" | urlize | safe }}',
      {},
      'foo <a href="http://www.example.com/">http://www.example.com/</a> bar',
    ],
    ['{{ "" | urlize }}|{{ "foo" | urlize }}', {}, '|foo'],
    [
      '{{ "http://jinja.pocoo.org/docs/templates/" | urlize | safe }}',
      {},
      '<a href="http://jinja.pocoo.org/docs/templates/">http://jinja.pocoo.org/docs/templates/</a>',
    ],
    [
      '{{ "https://jinja.pocoo.org/docs/templates/" | urlize | safe }}',
      {},
      '<a href="https://jinja.pocoo.org/docs/templates/">https://jinja.pocoo.org/docs/templates/</a>',
    ],
    [
      '{{ "www.pocoo.org/docs/templates/" | urlize | safe }}',
      {},
      '<a href="http://www.pocoo.org/docs/templates/">www.pocoo.org/docs/templates/</a>',
    ],
    [
      '{{ "pocoo.org/docs/templates/" | urlize | safe }}',
      {},
      '<a href="http://pocoo.org/docs/templates/">pocoo.org/docs/templates/</a>',
    ],
    [
      '{{ "pocoo.net/docs/templates/" | urlize | safe }}',
      {},
      '<a href="http://pocoo.net/docs/templates/">pocoo.net/docs/templates/</a>',
    ],
    [
      '{{ "pocoo.com/docs/templates/" | urlize | safe }}',
      {},
      '<a href="http://pocoo.com/docs/templates/">pocoo.com/docs/templates/</a>',
    ],
    [
      '{{ "pocoo.com:80" | urlize | safe }}|{{ "pocoo.com" | urlize | safe }}',
      {},
      '<a href="http://pocoo.com:80">pocoo.com:80</a>|<a href="http://pocoo.com">pocoo.com</a>',
    ],
    ['{{ "pocoo.commune" | urlize | safe }}', {}, 'pocoo.commune'],
    [
      '{{ "http://jinja.pocoo.org/docs/templates/" | urlize(12, true) | safe }}',
      {},
      '<a href="http://jinja.pocoo.org/docs/templates/" rel="nofollow">http://jinja</a>',
    ],
    [
      '{{ "(http://jinja.pocoo.org/docs/templates/" | urlize | safe }}',
      {},
      '<a href="http://jinja.pocoo.org/docs/templates/">http://jinja.pocoo.org/docs/templates/</a>',
    ],
    [
      '{{ "<http://jinja.pocoo.org/docs/templates/" | urlize | safe }}',
      {},
      '<a href="http://jinja.pocoo.org/docs/templates/">http://jinja.pocoo.org/docs/templates/</a>',
    ],
    [
      '{{ "&lt;http://jinja.pocoo.org/docs/templates/" | urlize | safe }}',
      {},
      '<a href="http://jinja.pocoo.org/docs/templates/">http://jinja.pocoo.org/docs/templates/</a>',
    ],
    [
      '{{ "http://jinja.pocoo.org/docs/templates/," | urlize | safe }}',
      {},
      '<a href="http://jinja.pocoo.org/docs/templates/">http://jinja.pocoo.org/docs/templates/</a>',
    ],
    [
      '{{ "http://jinja.pocoo.org/docs/templates/." | urlize | safe }}',
      {},
      '<a href="http://jinja.pocoo.org/docs/templates/">http://jinja.pocoo.org/docs/templates/</a>',
    ],
    [
      '{{ "http://jinja.pocoo.org/docs/templates/)" | urlize | safe }}',
      {},
      '<a href="http://jinja.pocoo.org/docs/templates/">http://jinja.pocoo.org/docs/templates/</a>',
    ],
    [
      '{{ "http://jinja.pocoo.org/docs/templates/\\n" | urlize | safe }}',
      {},
      '<a href="http://jinja.pocoo.org/docs/templates/">http://jinja.pocoo.org/docs/templates/</a>\n',
    ],
    [
      '{{ "http://jinja.pocoo.org/docs/templates/&gt;" | urlize | safe }}',
      {},
      '<a href="http://jinja.pocoo.org/docs/templates/">http://jinja.pocoo.org/docs/templates/</a>',
    ],
    [
      '{{ "http://testuser@testuser.com" | urlize | safe }}',
      {},
      '<a href="http://testuser@testuser.com">http://testuser@testuser.com</a>',
    ],
    [
      '{{ "testuser@testuser.com" | urlize | safe }}',
      {},
      '<a href="mailto:testuser@testuser.com">testuser@testuser.com</a>',
    ],
    ['{{ "foo." | urlize }}|{{ "foo.foo" | urlize }}', {}, 'foo.|foo.foo'],
    ['{{ "<b>what up</b>" | urlize | safe }}', {}, '<b>what up</b>'],
    ['{{ "what\\nup" | urlize | safe }}|{{ "what\\tup" | urlize | safe }}', {}, 'what\nup|what\tup'],
  ];
  try {
    for (const [source, context, expected] of cases) {
      assert.equal(await engine.render({ source }, context), expected, source);
    }
    const prototypeFreeUrlValues = Object.assign(Object.create(null) as Record<string, number | string>, {
      1: 2,
      '&1': '&2',
    });
    assert.equal(
      await engine.render(
        { source: '{{ value | urlencode | safe }}' },
        { value: prototypeFreeUrlValues },
      ),
      '1=2&%261=%262',
    );
    for (let index = 0; index < 100; index += 1) {
      const random = Number(await engine.render({ source: '{{ [1,2,3,4,5,6,7,8,9] | random }}' }));
      assert.ok(random >= 1 && random <= 9);
    }
    await assert.rejects(
      engine.render({ source: '{{ "value" | replace(r/a/z, "x") }}' }),
      error => error instanceof NunjitsuRenderError && error.code === 9,
    );
    assert.equal(await engine.render({ source: 'clean after invalid regex' }), 'clean after invalid regex');
    const customArray = Object.assign([0, 1], { key: 'value' });
    await assert.rejects(
      engine.render(
        { source: '{{ value | length }}' },
        { value: customArray } as unknown as TemplateContext,
      ),
      /cannot have custom properties/,
    );
    for (const value of [new String('blah'), new Map(), new Set()]) {
      await assert.rejects(
        engine.render(
          { source: '{{ value | length }}' },
          { value } as unknown as TemplateContext,
        ),
        /Only plain records/,
      );
    }
  } finally {
    await engine.dispose();
  }
});

test('matches built-in test semantics across copied values', async () => {
  const shared = { value: true };
  const engine = await createEngine();
  const cases: readonly [string, TemplateContext, string][] = [
    [
      '{% macro available() %}yes{% endmacro %}{{ available is callable }}|{{ "value" is not callable }}',
      {},
      'true|true',
    ],
    ['{{ missing is defined }}|{{ missing is not defined }}', {}, 'false|true'],
    ['{{ value is defined }}|{{ value is not defined }}', { value: null }, 'true|false'],
    [
      '{% if value is defined %}defined{% else %}undefined{% endif %}',
      {},
      'undefined',
    ],
    [
      '{% if value is not defined %}undefined{% else %}defined{% endif %}',
      { value: null },
      'defined',
    ],
    ['{{ missing is undefined }}|{{ value is not undefined }}', { value: null }, 'true|true'],
    [
      '{{ null is null }}|{{ none is none }}|{{ none is null }}|{{ missing is null }}',
      {},
      'true|true|true|false',
    ],
    ['{{ "6" is divisibleby(3) }}|{{ 3 is not divisibleby(2) }}', {}, 'true|true'],
    [
      '{{ safe is escaped }}|{{ unsafe is escaped }}',
      { safe: markSafe('value'), unsafe: 'value' },
      'true|false',
    ],
    ['{{ "5" is even }}|{{ 4 is not even }}', {}, 'false|false'],
    ['{{ "5" is odd }}|{{ 4 is not odd }}|{{ -1 is odd }}', {}, 'true|true|false'],
    ['{{ value is mapping }}|{{ list is mapping }}', { value: {}, list: [] }, 'true|false'],
    ['{{ 0 is falsy }}|{{ "pancakes" is not falsy }}', {}, 'true|true'],
    ['{{ null is truthy }}|{{ "pancakes" is not truthy }}', {}, 'false|false'],
    ['{{ "5" is greaterthan(4) }}|{{ 4 is not greaterthan(2) }}', {}, 'true|false'],
    ['{{ "5" is ge(5) }}|{{ 4 is not ge(2) }}', {}, 'true|false'],
    ['{{ "5" is lessthan(4) }}|{{ 4 is not lessthan(2) }}', {}, 'false|true'],
    ['{{ "5" is le(5) }}|{{ 4 is not le(2) }}', {}, 'true|true'],
    ['{{ 5 is ne(5) }}|{{ 4 is not ne(2) }}|{{ "5" is ne(5) }}', {}, 'false|false|true'],
    ['{{ value is iterable }}|{{ text is iterable }}', { value: [], text: 'value' }, 'true|true'],
    ['{{ 5 is number }}|{{ "42" is number }}', {}, 'true|false'],
    ['{{ 5 is string }}|{{ "42" is string }}', {}, 'false|true'],
    ['{{ 1 is equalto(2) }}|{{ 2 is not equalto(2) }}', {}, 'false|false'],
    ['{{ first is sameas(second) }}', { first: shared, second: shared }, 'true'],
    [
      '{{ "foobar" is lower }}|{{ "Foobar" is lower }}|{{ "FOOBAR" is upper }}|{{ "Foobar" is upper }}',
      {},
      'true|false|true|false',
    ],
  ];
  try {
    for (const [source, context, expected] of cases) {
      assert.equal(await engine.render({ source }, context), expected, source);
    }
    await assert.rejects(
      engine.render(
        { source: '{{ value is callable }}' },
        { value: () => true } as unknown as TemplateContext,
      ),
      /Unsupported template value of type function/,
    );
  } finally {
    await engine.dispose();
  }
});

test('provides render-local range, cycler, and joiner globals', async () => {
  const engine = await createEngine();
  const cases: readonly [string, string][] = [
    ['{% for i in range(0, 10) %}{{ i }}{% endfor %}', '0123456789'],
    ['{% for i in range(10) %}{{ i }}{% endfor %}', '0123456789'],
    ['{% for i in range(5, 10) %}{{ i }}{% endfor %}', '56789'],
    ['{% for i in range(-2, 0) %}{{ i }}{% endfor %}', '-2-1'],
    ['{% for i in range(5, 10, 2) %}{{ i }}{% endfor %}', '579'],
    ['{% for i in range(5, 10, 2.5) %}{{ i }}{% endfor %}', '57.5'],
    ['{% for i in range(10, 5, -1) %}{{ i }}{% endfor %}', '109876'],
    ['{% for i in range(10, 5, -2.5) %}{{ i }}{% endfor %}', '107.5'],
    [
      '{% set cls = cycler("odd", "even") %}{{ cls.next() }}{{ cls.next() }}{{ cls.next() }}',
      'oddevenodd',
    ],
    [
      '{% set cls = cycler("odd", "even") %}{{ cls.next() }}{{ cls.reset() }}{{ cls.next() }}',
      'oddodd',
    ],
    [
      '{% set cls = cycler("odd", "even") %}{{ cls.next() }}{{ cls.next() }}{{ cls.current }}',
      'oddeveneven',
    ],
    [
      '{% set comma = joiner() %}foo{{ comma() }}bar{{ comma() }}baz{{ comma() }}',
      'foobar,baz,',
    ],
    [
      '{% set pipe = joiner("|") %}foo{{ pipe() }}bar{{ pipe() }}baz{{ pipe() }}',
      'foobar|baz|',
    ],
  ];
  try {
    for (const [source, expected] of cases) {
      assert.equal(await engine.render({ source }), expected, source);
    }
  } finally {
    await engine.dispose();
  }

  const configured = await createEngine({
    globals: {
      hello(arguments_) {
        return `Hello ${String(arguments_[0])}`;
      },
      goodbye(arguments_) {
        return `Goodbye ${String(arguments_[0])}`;
      },
    },
  });
  const isolated = await createEngine();
  try {
    assert.equal(
      await configured.render({ source: '{{ hello("World!") }}|{{ goodbye("World!") }}' }),
      'Hello World!|Goodbye World!',
    );
    await assert.rejects(
      isolated.render({ source: '{{ hello("World!") }}' }),
      error => error instanceof NunjitsuRenderError && error.code === 8,
    );
  } finally {
    await Promise.all([configured.dispose(), isolated.dispose()]);
  }
});

test('evaluates Jinja-compatible array slices', async () => {
  const engine = await createEngine();
  const context = { arr: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], n: 1 };
  const cases: readonly [string, string][] = [
    ['{% for i in arr[1:4] %}{{ i }}{% endfor %}', 'bcd'],
    ['{% for i in arr[n:n+3] %}{{ i }}{% endfor %}', 'bcd'],
    ['{% for i in arr[3:] %}{{ i }}{% endfor %}', 'defgh'],
    ['{% for i in arr[-3:] %}{{ i }}{% endfor %}', 'fgh'],
    ['{% for i in arr[:4] %}{{ i }}{% endfor %}', 'abcd'],
    ['{% for i in arr[:-3] %}{{ i }}{% endfor %}', 'abcde'],
    ['{% for i in arr[::2] %}{{ i }}{% endfor %}', 'aceg'],
    ['{% for i in arr[::-1] %}{{ i }}{% endfor %}', 'hgfedcba'],
    ['{% for i in arr[4::-1] %}{{ i }}{% endfor %}', 'edcba'],
    ['{% for i in arr[-5::-1] %}{{ i }}{% endfor %}', 'dcba'],
    ['{% for i in arr[:3:-1] %}{{ i }}{% endfor %}', 'hgfe'],
    ['{% for i in arr[1::2] %}{{ i }}{% endfor %}', 'bdfh'],
    ['{% for i in arr[1:7:2] %}{{ i }}{% endfor %}', 'bdf'],
  ];
  try {
    for (const [source, expected] of cases) {
      assert.equal(await engine.render({ source }, context), expected, source);
    }
  } finally {
    await engine.dispose();
  }
});

test('dispatches immutable async filters, tests, and globals through safe copied values', async () => {
  let markBlockingCallStarted: (() => void) | undefined;
  const blockingCallStarted = new Promise<void>(resolve => {
    markBlockingCallStarted = resolve;
  });
  const engine = await createEngine({
    autoescape: true,
    workerPool: { minWorkers: 1, maxWorkers: 1 },
    loaders: [memoryLoader({ 'chosen.njk': 'loaded {{ value }}' })],
    filters: {
      async suffix(input, arguments_) {
        await Promise.resolve();
        return `${String(input)}${String(arguments_[0])}`;
      },
      trusted(input) {
        return markSafe(`<strong>${String(input)}</strong>`);
      },
      async blocking(_input, _arguments, { signal }) {
        markBlockingCallStarted?.();
        return await new Promise<never>((_resolve, reject) => {
          const rejectAborted = () => {
            const error = new Error('capability aborted');
            error.name = 'AbortError';
            reject(error);
          };
          if (signal.aborted) {
            rejectAborted();
          } else {
            signal.addEventListener('abort', rejectAborted, { once: true });
          }
        });
      },
    },
    tests: {
      odd(input) {
        return typeof input === 'number' && input % 2 === 1;
      },
    },
    globals: {
      async greet(arguments_) {
        await Promise.resolve();
        return `Hello ${String(arguments_[0])}`;
      },
      async select(arguments_) {
        await Promise.resolve();
        return arguments_[0] ?? null;
      },
      explode() {
        throw new Error('ERROR');
      },
      describe(arguments_) {
        const [user, flags] = arguments_;
        assert.equal(Object.getPrototypeOf(user), null);
        assert.ok(Object.isFrozen(user));
        assert.ok(Array.isArray(flags));
        assert.ok(Object.isFrozen(flags));
        return `${String((user as Record<string, unknown>).name)}:${String(flags[0])}`;
      },
    },
    tags: {
      badge: {
        type: 'inline',
        async render(arguments_) {
          await Promise.resolve();
          return `<span>${String(arguments_[0])}:${String(arguments_[1])}</span>`;
        },
      },
      trustedBadge: {
        type: 'inline',
        render(arguments_) {
          return markSafe(`<b>${String(arguments_[0])}</b>`);
        },
      },
    },
  });

  try {
    assert.equal(
      await engine.render(
        {
          source: [
            '{{ greet("World") | suffix(punctuation) }}',
            '{{ count is odd }}',
            '{{ count is not odd }}',
            '{{ unsafe | trusted }}',
            '{{ describe(user, flags) }}',
            '{% badge("new", user.name) %}',
            '{% trustedBadge("safe") %}',
          ].join('|'),
        },
        {
          punctuation: '!',
          count: 3,
          unsafe: '<tag>',
          user: { name: 'copied' },
          flags: ['first'],
        },
      ),
      'Hello World!|true|false|<strong><tag></strong>|copied:first|&lt;span&gt;new:copied&lt;/span&gt;|<b>safe</b>',
    );
    assert.equal(
      (await Array.fromAsync(
        engine.renderStream({ source: 'before{{ "x" | suffix("y") }}after' }),
      )).join(''),
      'beforexyafter',
    );
    assert.equal(
      (await Array.fromAsync(
        engine.renderStream(
          { source: 'before{% include select("chosen.njk") %}after' },
          { value: 'asynchronously' },
        ),
      )).join(''),
      'beforeloaded asynchronouslyafter',
    );
    await assert.rejects(
      engine.render(
        { source: '{{ "x" | suffix("a") | suffix("b") }}' },
        {},
        { limits: { capabilityCalls: 1 } },
      ),
      error => error instanceof NunjitsuLimitError,
    );
    await assert.rejects(
      engine.render({ source: '{{ value | absent }}' }, { value: 'x' }),
      error => error instanceof NunjitsuRenderError && error.code === 8,
    );
    await assert.rejects(
      engine.render({ source: '{% absentTag %}' }),
      error => error instanceof NunjitsuRenderError && error.code === 5,
    );
    await assert.rejects(engine.render({ source: '{{ explode() }}' }), /ERROR/);

    const controller = new AbortController();
    const rendering = engine.render(
      { source: '{{ "x" | blocking }}' },
      {},
      { signal: controller.signal },
    );
    await blockingCallStarted;
    controller.abort();
    await assert.rejects(rendering, error => error instanceof Error && error.name === 'AbortError');
    assert.equal(await engine.render({ source: 'clean' }), 'clean');
  } finally {
    await engine.dispose();
  }
});

test('renders declarative custom tag bodies and ordered intermediate sections', async () => {
  const engine = await createEngine({
    autoescape: true,
    filters: {
      async suffix(input, arguments_) {
        await Promise.resolve();
        return `${String(input)}${String(arguments_[0])}`;
      },
    },
    tags: {
      reverse: {
        type: 'body',
        intermediateTags: ['intermediate'],
        async render(invocation) {
          await Promise.resolve();
          assert.ok(Object.isFrozen(invocation));
          assert.ok(Object.isFrozen(invocation.arguments));
          assert.ok(Object.isFrozen(invocation.keywordArguments));
          assert.equal(Object.getPrototypeOf(invocation.keywordArguments), null);
          assert.ok(Object.isFrozen(invocation.sections));
          assert.equal(Object.getPrototypeOf(invocation.sections), null);
          const prefix = String(invocation.arguments[0] ?? '');
          const cutoff = invocation.keywordArguments.cutoff;
          const reversed = Array.from(invocation.body).reverse().join('');
          const first = typeof cutoff === 'number' ? reversed.slice(0, cutoff) : reversed;
          const second = invocation.sections.intermediate === undefined
            ? ''
            : Array.from(invocation.sections.intermediate).reverse().join('');
          return markSafe(`${prefix}${first}${second}`);
        },
      },
    },
  });

  try {
    assert.equal(
      await engine.render({ source: '{% reverse %}123456789{% endreverse %}' }),
      '987654321',
    );
    assert.equal(
      await engine.render({ source: '{% reverse "prefix:" %}abc{% endreverse %}' }),
      'prefix:cba',
    );
    assert.equal(
      await engine.render({
        source: '{% reverse("biz", cutoff=5) %}foo{{ "b" | suffix("ar") }}{% endreverse %}',
      }),
      'bizraboo',
    );
    assert.equal(
      await engine.render({
        source: '{% reverse %}abcdefg{% intermediate %}second half{% endreverse %}',
      }),
      'gfedcbaflah dnoces',
    );
    assert.equal(
      await engine.render({
        source: '{% reverse %}a{% reverse %}bc{% endreverse %}d{% endreverse %}',
      }),
      'dbca',
    );
  } finally {
    await engine.dispose();
  }
});

test('evaluates nested and resumable if branches without rendering inactive bodies', async () => {
  const engine = await createEngine({
    tests: {
      async enabled(input) {
        await Promise.resolve();
        return input === 'enabled';
      },
    },
  });
  try {
    const template = {
      source: [
        '{% if outer %}',
        'outer:',
        '{% if inner %}inner{% else %}fallback{% endif %}',
        '{% else %}',
        '{% if alternate %}alternate{% elif final %}final{% else %}none{% endif %}',
        '{% endif %}',
      ].join(''),
    };
    assert.equal(
      await engine.render(template, { outer: true, inner: true }),
      'outer:inner',
    );
    assert.equal(
      await engine.render(template, { outer: true, inner: false }),
      'outer:fallback',
    );
    assert.equal(
      await engine.render(template, { outer: false, alternate: true }),
      'alternate',
    );
    assert.equal(
      await engine.render(template, { outer: false, alternate: false, final: true }),
      'final',
    );
    assert.equal(
      await engine.render(template, { outer: false, alternate: false, final: false }),
      'none',
    );
    assert.equal(
      await engine.render(
        { source: '{% if not hungry %}good{% else %}bad{% endif %}' },
        { hungry: false },
      ),
      'good',
    );
    assert.equal(
      await engine.render(
        { source: '{% if hungry and like_pizza %}good{% endif %}' },
        { hungry: true, like_pizza: true },
      ),
      'good',
    );
    assert.equal(
      await engine.render(
        { source: '{% if hungry or like_pizza %}good{% endif %}' },
        { hungry: false, like_pizza: true },
      ),
      'good',
    );
    assert.equal(
      await engine.render(
        { source: '{% if (hungry or like_pizza) and anchovies %}good{% endif %}' },
        { hungry: false, like_pizza: true, anchovies: true },
      ),
      'good',
    );
    assert.equal(
      await engine.render(
        {
          source: [
            '{% if food == "pizza" %}pizza{% endif %}',
            '{% if food =="beer" %}beer{% endif %}',
            '{% if "pizza" in menu %} menu{% endif %}',
          ].join(''),
        },
        { food: 'beer', menu: { pizza: true } },
      ),
      'beer menu',
    );
    assert.equal(
      await engine.render(
        {
          source: [
            '{% if topping == "pepperoni" %}yum',
            '{% elseif topping == "anchovies" %}yuck',
            '{% else %}hmmm{% endif %}',
          ].join(''),
        },
        { topping: 'sausage' },
      ),
      'hmmm',
    );
    assert.equal(
      await engine.render(
        { source: '{{ "6" == 6 }}|{{ "6" === 6 }}|{{ "z" > "a" }}' },
      ),
      'true|false|true',
    );
    assert.equal(
      (await Array.fromAsync(engine.renderStream(
        { source: 'before{% if value is enabled %}yes{% else %}no{% endif %}after' },
        { value: 'enabled' },
      ))).join(''),
      'beforeyesafter',
    );
    assert.equal(
      await engine.render(
        { source: '{% if value is not enabled %}disabled{% else %}enabled{% endif %}' },
        { value: 'disabled' },
      ),
      'disabled',
    );
    await assert.rejects(
      engine.render({ source: '{% if value %}unclosed' }, { value: false }),
      error => error instanceof NunjitsuRenderError && error.code === 5,
    );
    await assert.rejects(
      engine.render({ source: '{% if value %}{{ unclosed{% endif %}' }, { value: false }),
      error => error instanceof NunjitsuRenderError && error.code === 3,
    );
  } finally {
    await engine.dispose();
  }
});

test('iterates slot-backed arrays and records with nested local scopes', async () => {
  const engine = await createEngine({
    loaders: [memoryLoader({ 'item.njk': '<{{ item }}>' })],
  });
  try {
    const list = { source: '{% for item in items %}[{{ item }}]{% else %}empty{% endfor %}' };
    assert.equal(await engine.render(list, { items: ['a', 'b', 'c'] }), '[a][b][c]');
    assert.equal(await engine.render(list, { items: [] }), 'empty');
    assert.equal(await engine.render(list, {}), 'empty');
    assert.equal(
      await engine.render(
        {
          source: [
            '{% for row in rows %}',
            '{% for item in row %}{{ item }}{% endfor %}',
            ':{{ row.0 }};',
            '{% endfor %}',
          ].join(''),
        },
        { rows: [['a', 'b'], ['c']] },
      ),
      'ab:a;c:c;',
    );
    assert.equal(
      await engine.render(
        { source: '{% for key, value in pairs %}{{ key }}={{ value }};{% endfor %}' },
        { pairs: [['a', 1], ['b', 2]] },
      ),
      'a=1;b=2;',
    );
    assert.equal(
      await engine.render(
        { source: '{% for a, b, c in values %}{{ a }}{{ b }}{{ c }}{% endfor %}' },
        { values: [['x', 'y']], c: 'must not leak' },
      ),
      'xy',
    );
    assert.equal(
      await engine.render(
        { source: '{% for key, value in values %}{{ key }}={{ value }};{% endfor %}' },
        { values: { first: 1, second: 2 } },
      ),
      'first=1;second=2;',
    );
    assert.equal(
      await engine.render(
        {
          source: [
            '{% for item in items %}',
            '{{ loop.index }}/{{ loop.index0 }}/{{ loop.revindex }}/{{ loop.revindex0 }}/',
            '{{ loop.first }}/{{ loop.last }}/{{ loop.length }}:{{ item }};',
            '{% endfor %}',
          ].join(''),
        },
        { items: ['a', 'b'] },
      ),
      '1/0/2/1/true/false/2:a;2/1/1/0/false/true/2:b;',
    );
    assert.equal(
      await engine.render({
        source: [
          '{% for item in [7, 3, 6] %}{{ loop.index }}:{{ item }};{% endfor %}',
          '{% for key, value in { one: 1, two: 2 } %}{{ key }}={{ value }};{% endfor %}',
          '{{ "a" in ["a", "b"] }}|{{ [1, 2, 3] | reverse | first }}',
        ].join(''),
      }),
      '1:7;2:3;3:6;one=1;two=2;true|3',
    );
    assert.equal(
      (await Array.fromAsync(engine.renderStream(
        { source: '{% for item in items %}{% include "item.njk" %}{% endfor %}' },
        { items: ['x', 'y'] },
      ))).join(''),
      '<x><y>',
    );
  } finally {
    await engine.dispose();
  }
});

test('keeps resumable assignments scoped across loops and includes', async () => {
  const engine = await createEngine({
    autoescape: false,
    loaders: [memoryLoader({
      'mutate.njk': '{% set value = "inside" %}{{ value }}',
      'capture-item.njk': '<{{ item }}>',
    })],
    globals: {
      async greet(arguments_) {
        await Promise.resolve();
        return `Hello ${String(arguments_[0])}`;
      },
    },
  });
  try {
    assert.equal(
      await engine.render({
        source: [
          '{% set value = "root" %}',
          '{{ value }}:',
          '{% include "mutate.njk" %}:',
          '{{ value }}',
        ].join(''),
      }),
      'root:inside:root',
    );
    assert.equal(
      await engine.render({
        source: [
          '{% set item = "outer" %}',
          '{% for value in [1, 2] %}',
          '{% set item = value %}{{ item }}',
          '{% endfor %}',
          ':{{ item }}',
        ].join(''),
      }),
      '12:2',
    );
    assert.equal(
      (await Array.fromAsync(engine.renderStream({
        source: '{% set greeting = greet("World") %}before {{ greeting }} after',
      }))).join(''),
      'before Hello World after',
    );
    assert.equal(
      await engine.render({
        source: [
          '{% set captured %}',
          '{% for item in [1, 2] %}',
          '{% include "capture-item.njk" %}{{ greet(item) }}',
          '{% endfor %}',
          '{% endset %}',
          '{{ captured }}',
        ].join(''),
      }),
      '<1>Hello 1<2>Hello 2',
    );
    assert.equal(
      await engine.render({
        source: [
          '{% set outer %}',
          '{% set inner %}item {% for i in [1, 2, 3] %}{{ i }} {% endfor %}{% endset %}',
          '{% for i in [1, 2] %}{{ i }}={{ inner }};{% endfor %}',
          '{% endset %}',
          '{{ outer }}',
        ].join(''),
      }),
      '1=item 1 2 3 ;2=item 1 2 3 ;',
    );
    assert.equal(
      await engine.render({
        source: '{% set x, y, z %}cool{% endset %}{{ x }} {{ y }} {{ z }}',
      }),
      'cool cool cool',
    );
    assert.deepEqual(
      await Array.fromAsync(engine.renderStream({
        source: 'before{% set captured %}hidden{% endset %}after:{{ captured }}',
      })),
      ['before', 'after:', 'hidden'],
    );
    await assert.rejects(
      engine.render({ source: '{% set captured %}unclosed' }),
      error => error instanceof NunjitsuRenderError && error.code === 5,
    );
    assert.equal(
      await engine.render({ source: 'clean after capture failure' }),
      'clean after capture failure',
    );
  } finally {
    await engine.dispose();
  }
});

test('executes deferred macros in isolated captured scopes', async () => {
  const engine = await createEngine({
    autoescape: true,
    loaders: [memoryLoader({ 'macro-include.njk': 'included {{ value }}' })],
  });
  try {
    assert.equal(
      await engine.render(
        {
          source: [
            '{% macro wrap(value) %}<b>{{ value }}</b>{% endmacro %}',
            '{% macro optional(x, y) %}{{ x }}:{{ y }}{% endmacro %}',
            '{{ wrap(input) }}|{{ optional("first") }}',
          ].join(''),
        },
        { input: '<unsafe>' },
      ),
      '<b>&lt;unsafe&gt;</b>|first:',
    );
    assert.equal(
      await engine.render({
        source: [
          '{% macro inner() %}inner{% endmacro %}',
          '{% macro outer() %}',
          '{% set local %}captured{% endset %}',
          '{% include "macro-include.njk" %}:{{ inner() }}:{{ local }}',
          '{% endmacro %}',
          '{{ outer() }}|{{ local }}',
        ].join(''),
      }, { value: 'value' }),
      'included value:inner:captured|',
    );
    assert.equal(
      await engine.render({
        source: [
          '{% macro one(value) %}{{ two() }}{% endmacro %}',
          '{% macro two() %}{{ value }}{% endmacro %}',
          '{{ one("hidden") }}',
        ].join(''),
      }),
      '',
    );
    assert.equal(
      await engine.render({
        source: [
          '{% macro values(x, y=2, z=y) %}{{ x }}{{ y }}{{ z }}{% endmacro %}',
          '{{ values(1, z=3) }}|{{ values(x=1, y=4) }}|{{ values(1, 10, 20) }}',
        ].join(''),
      }),
      '123|144|11020',
    );
    assert.deepEqual(
      await Array.fromAsync(engine.renderStream({
        source: 'before{% macro value() %}macro{% endmacro %}{{ value() }}after',
      })),
      ['before', 'macroafter'],
    );
  } finally {
    await engine.dispose();
  }
});

test('resolves inherited blocks through bounded one-shot frames', async () => {
  const engine = await createEngine({
    loaders: [memoryLoader({
      'base.njk': 'A{% block content %}base{% endblock %}B{% block footer %}base footer{% endblock %}C',
      'middle.njk': [
        '{% extends "base.njk" %}',
        '{% block content %}middle{% endblock %}',
        '{% block footer %}middle footer{% endblock %}',
      ].join(''),
      'simple-base.njk': '{% block test %}base{% endblock test %}',
    })],
  });
  try {
    assert.equal(
      await engine.render({
        source: '{% extends parent %}{% block content %}child{% endblock %}',
      }, { parent: 'middle.njk' }),
      'AchildBmiddle footerC',
    );
    assert.equal(
      (await Array.fromAsync(engine.renderStream({
        source: '{% extends "base.njk" %}{% block content %}streamed{% endblock %}',
      }))).join(''),
      'AstreamedBbase footerC',
    );
    assert.equal(
      await engine.render({ source: '{% extends "simple-base.njk" %}' }),
      'base',
    );
    await assert.rejects(
      engine.render({
        source: [
          '{% extends "simple-base.njk" %}',
          '{% block test %}first{% endblock %}',
          '{% block test %}second{% endblock %}',
        ].join(''),
      }),
      error => error instanceof NunjitsuRenderError && error.code === 5,
    );
  } finally {
    await engine.dispose();
  }
});

test('loads imported macro namespaces without rendering module text', async () => {
  const engine = await createEngine({
    loaders: [memoryLoader({
      'macros.njk': 'ignored{% macro value() %}macro{% endmacro %}ignored',
    })],
  });
  try {
    assert.equal(
      await engine.render({
        source: 'before{% import "macros.njk" as macros %}{{ macros.value() }}after',
      }),
      'beforemacroafter',
    );
    await assert.rejects(
      engine.render({
        source: '{% from "macros.njk" import absent %}',
      }),
      error => error instanceof NunjitsuRenderError && error.code === 9,
    );
  } finally {
    await engine.dispose();
  }
});

test('rejects invalid expressions and calls across deferred template frames', async () => {
  const engine = await createEngine({
    loaders: [memoryLoader({
      'undefined-macro.njk': '{{ undef() }}',
      'macro-call-undefined-macro.njk': [
        '{% macro defined_macro(useless) %}',
        '{% include "undefined-macro.njk" %}',
        '{% endmacro %}',
      ].join(''),
      'import-macro-call-undefined-macro.njk': [
        '{% import "macro-call-undefined-macro.njk" as t %}',
        '{% for el in list %}{{ t.defined_macro() }}{% endfor %}',
      ].join(''),
      'foo': '{% macro _bar() %}private{% endmacro %}',
    })],
  });
  try {
    for (const [source, context] of [
      ['{{ foo("cvan") }}', {}],
      ['{{ foo["bar"]("cvan") }}', {}],
      ['{{ foo.bar("second call") }}', {}],
      ['{{ foo.barThatIsLongerThanTen() }}', {}],
      ['{{ foo.bar("multiple", "args") }}', {}],
      ['{{ foo["bar"]["zip"]("multiple", "args") }}', {}],
      ['hello {{ foo', {}],
      ['hello {% if', {}],
      ['hello {% if sdf zxc', {}],
      ['{% include "foo %}', {}],
      ['hello {% if sdf %} data', {}],
      ['hello {% block sdf %} data', {}],
      ['hello {% block sdf %} data{% endblock foo %}', {}],
      ['hello {% bar %} dsfsdf', {}],
      ['{{ foo(bar baz) }}', {}],
      ['{% import "foo" %}', {}],
      ['{% from "foo" %}', {}],
      ['{% from "foo" import bar baz %}', {}],
      ['{% from "foo" import _bar %}', {}],
      ['{{ "x" | replace(r/x$/iv, "y") }}', {}],
      ['{% call foo() %}{% endcall %}', { foo: 'bar' }],
      ['{% include "undefined-macro.njk" %}', {}],
      ['{% if true %}{% include "undefined-macro.njk" %}{% endif %}', {}],
      ['{% include "import-macro-call-undefined-macro.njk" %}', { list: [1, 2, 3] }],
      [' {{ 2 + 2- }}', {}],
      ['{% if "a" in 1 %}yes{% endif %}', {}],
      ['{% if "a" in obj %}yes{% endif %}', {}],
    ] as const) {
      await assert.rejects(
        engine.render({ source }, context),
        error => error instanceof NunjitsuRenderError && [3, 5, 8, 9].includes(error.code),
        source,
      );
    }
  } finally {
    await engine.dispose();
  }
});

test('handles trailing macro values through the safe slot boundary', async () => {
  const noPrototype = Object.assign(Object.create(null) as Record<string, string>, {
    qux: 'world',
  });
  const inheritedName = '__nunjitsuInheritedRuntimeValue__';
  const previousDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, inheritedName);
  Object.defineProperty(Object.prototype, inheritedName, {
    configurable: true,
    enumerable: true,
    value: 'function(){ return 1+2; }()',
  });
  const engine = await createEngine();

  try {
    assert.equal(
      await engine.render({
        source: [
          '{% macro foo(bar, baz) %}{{ bar }} {{ baz }}{% endmacro %}',
          '{{ foo("hello", nosuchvar) }}',
        ].join(''),
      }),
      'hello ',
    );
    assert.equal(
      await engine.render({
        source: [
          '{% macro foo(bar, baz) %}{{ bar }} {{ baz.qux }}{% endmacro %}',
          '{{ foo("hello", noPrototype) }}',
        ].join(''),
      }, { noPrototype }),
      'hello world',
    );
    assert.equal(
      await engine.render({ source: `{{ ${inheritedName} }}` }, {}),
      '',
    );
  } finally {
    await engine.dispose();
    if (previousDescriptor) {
      Object.defineProperty(Object.prototype, inheritedName, previousDescriptor);
    } else {
      delete (Object.prototype as Record<string, unknown>)[inheritedName];
    }
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

test('cancels a partially consumed stream and recycles its reserved worker', async () => {
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
    loaders: [delayedLoader],
    workerPool: { minWorkers: 1, maxWorkers: 1 },
  });
  try {
    const reader = engine.renderStream(
      { source: 'before{{ value }}{% include "delayed.njk" %} after' },
      { value: 'yield' },
    ).getReader();
    assert.deepEqual(await reader.read(), { value: 'before', done: false });
    assert.deepEqual(await reader.read(), { value: 'yield', done: false });
    await loadStarted;
    await reader.cancel();
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
      [{ source: '{{ value | upper }}' }, { arenaBytes: 64 }],
      [{ name: 'entry.njk' }, { includeDepth: 1 }],
      [{ name: 'entry.njk' }, { loaderCalls: 1 }],
    ] as const) {
      await assert.rejects(
        engine.render(template, { value: 'large input'.repeat(16) }, { limits }),
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
