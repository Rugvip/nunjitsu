import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createEngine,
  NunjitsuLimitError,
  NunjitsuRenderError,
} from '../../src/index.ts';

test('renders control flow, loops, macros, call blocks, and assignments', () => {
  const engine = createEngine();
  const source = [
    '{% set prefix = "item" %}',
    '{% macro row(value, suffix="!") %}${{ prefix }}:${{ value }}${{ suffix }}{% endmacro %}',
    '{% for value in values %}',
    '${{ loop.index }}=${{ row(value, suffix="?") }};',
    '{% else %}empty{% endfor %}',
    '{% if enabled %}yes{% else %}no{% endif %}',
    '{% switch choice %}{% case "a" %}A{% case "b" %}B{% default %}D{% endswitch %}',
  ].join('');

  assert.equal(
    engine.render(source, { values: ['x', 'y'], enabled: true, choice: 'b' }),
    '1=item:x?;2=item:y?;yesB',
  );
  assert.equal(
    engine.render('{% for value in values %}${{ value }}{% else %}empty{% endfor %}', {
      values: [],
    }),
    'empty',
  );
  assert.equal(
    engine.render([
      '{% for character in text %}${{ loop.index }}:${{ character }}:${{ loop.length }};{% endfor %}',
      '{% for key, value in record %}${{ key }}=${{ value }};{% endfor %}',
    ].join(''), {
      text: 'A😀',
      record: { first: 1, second: 2 },
    }),
    '1:A:2;2:😀:2;first=1;second=2;',
  );
});

test('matches built-in filters, tests, globals, comments, and raw regions', () => {
  const engine = createEngine();
  assert.equal(
    engine.render([
      '{# omitted #}',
      '${{ "hello world" | title }}|',
      '${{ [3, 1, 2] | sort | join(",") }}|',
      '${{ 4 is even }}:${{ missing is undefined }}|',
      '{% for value in range(1, 4) %}${{ value }}{% endfor %}|',
      '{% raw %}${{ untouched }}{% endraw %}',
    ].join('')),
    'Hello World|1,2,3|true:true|123|${{ untouched }}',
  );
});

test('dispatches only registered synchronous filters and globals', () => {
  const callbackInputs: unknown[] = [];
  const engine = createEngine({
    filters: {
      append(input, suffix) {
        callbackInputs.push(input, suffix);
        return `${input}${suffix}`;
      },
      absent() {
        return undefined;
      },
    },
    globals: {
      environment: { name: 'production' },
      repeat(value, count) {
        return String(value).repeat(Number(count));
      },
    },
  });

  assert.equal(
    engine.render([
      '${{ "a" | append("b") }}|',
      '${{ "x" | absent }}|',
      '${{ environment.name }}|',
      '${{ repeat("z", 3) }}',
    ].join('')),
    'ab||production|zzz',
  );
  assert.deepEqual(callbackInputs, ['a', 'b']);
  assert.throws(() => engine.render('${{ missingGlobal() }}'), /Unable to call/);

  const invalid = createEngine({
    filters: {
      promise() {
        return Promise.resolve('blocked') as never;
      },
    },
  });
  assert.throws(() => invalid.render('${{ "x" | promise }}'), /plain records/);
});

test('supports Cookiecutter variables, jsonify, slices, and Jinja constants', () => {
  const engine = createEngine({ cookiecutterCompat: true });
  assert.equal(
    engine.render([
      '{{ cookiecutter.name }}|',
      '{{ cookiecutter.items[1:3] | jsonify }}|',
      '{{ True }}:{{ False }}:{{ None is none }}',
    ].join(''), {
      cookiecutter: { name: 'demo', items: [1, 2, 3, 4] },
    }),
    'demo|[2,3]|true:false:true',
  );
});

test('uses fixed unescaped output and explicit escape filtering', () => {
  const engine = createEngine();
  assert.equal(
    engine.render('${{ value }}|${{ value | escape }}', { value: '<script>"x"</script>' }),
    '<script>"x"</script>|&lt;script&gt;&quot;x&quot;&lt;/script&gt;',
  );
});

test('resolves constant and computed lookups through closed operations', () => {
  const engine = createEngine();
  assert.equal(
    engine.render([
      '${{ record.name }}:',
      '${{ record["name"] }}:',
      '${{ list[1] }}:',
      '${{ text.length }}:',
      '${{ record[key] }}',
    ].join(''), {
      record: { name: 'value' },
      list: ['zero', 'one'],
      text: 'four',
      key: 'name',
    }),
    'value:value:one:4:value',
  );
});

test('applies whitespace options to each complete inline source', () => {
  const engine = createEngine({ trimBlocks: true, lstripBlocks: true });
  assert.equal(
    engine.render('a\n    {% if true %}\n    b\n    {% endif %}\nc'),
    'a\n    b\nc',
  );
});

test('enforces finite resource limits and recovers after failures', () => {
  const engine = createEngine({
    filters: {
      identity(value) {
        return value;
      },
    },
  });
  const failures: Array<() => unknown> = [
    () => engine.render('source', {}, { limits: { sourceCodeUnits: 1 } }),
    () => engine.render('${{ value }}', { value: 'output' }, { limits: { outputCodeUnits: 1 } }),
    () => engine.render('{% for value in values %}${{ value }}{% endfor %}', {
      values: [1, 2, 3],
    }, { limits: { workUnits: 2 } }),
    () => engine.render('${{ value | identity }}', { value: 'x' }, {
      limits: { capabilityCalls: 0 },
    }),
    () => engine.render('${{ value | identity }}', { value: 'large' }, {
      limits: { scratchBytes: 1 },
    }),
  ];
  for (const failure of failures) {
    assert.throws(failure, error => error instanceof NunjitsuLimitError);
    assert.equal(engine.render('clean'), 'clean');
  }
  assert.throws(
    () => engine.render('${{ 1 + 2 }}', {}, { limits: { nestingDepth: 2 } }),
    error => error instanceof NunjitsuLimitError && error.limit === 'nestingDepth',
  );
  assert.equal(engine.render('clean'), 'clean');
  assert.equal(
    engine.render('😀', {}, { limits: { outputCodeUnits: 2 } }),
    '😀',
  );
});

test('wraps parse and evaluation failures without retaining render state', () => {
  const engine = createEngine();
  assert.throws(
    () => engine.render('${{ broken( }}'),
    error => error instanceof NunjitsuRenderError,
  );
  assert.throws(
    () => engine.render('${{ value.toString() }}', { value: 'x' }),
    error => error instanceof NunjitsuRenderError,
  );
  assert.equal(engine.render('${{ value }}', { value: 'clean' }), 'clean');
});
