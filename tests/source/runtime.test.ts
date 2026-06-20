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
  TemplateNotFoundError,
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
    'dynamic.njk': [
      '{% set chosen = "nested.njk" %}',
      '{% include chosen %}|',
      '{% include selection.name %}|',
      '{% include "NESTED.NJK" | lower %}',
    ].join(''),
    'cycle-a.njk': '{% include "cycle-b.njk" %}',
    'cycle-b.njk': '{% include "cycle-a.njk" %}',
    'missing-include.njk': '{% include "absent.njk" %}',
    'optional-include.njk': 'before{% include "absent.njk" ignore missing %}after',
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

test('streams evaluator chunks with backpressure and preserves partial failure semantics', async () => {
  let includeLoads = 0;
  let markIncludeStarted: (() => void) | undefined;
  const includeStarted = new Promise<void>(resolve => {
    markIncludeStarted = resolve;
  });
  const engine = await createEngine({
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
        source: '   {% set a = 1 %} {% set b = 2 %}{{ a }}{{ b }}',
      }),
      ' 12',
    );
  } finally {
    await configured.dispose();
  }
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

test('iterates arena-backed arrays and records with nested local scopes', async () => {
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
