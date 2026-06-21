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

test('matches stateful range, cycler, and joiner globals', () => {
  const engine = createEngine({ cookiecutterCompat: true });
  assert.equal(
    engine.render('{% for i in range(10, 5, -2.5) %}{{ i }}{% endfor %}'),
    '107.5',
  );
  assert.equal(
    engine.render([
      '{% set cls = cycler("odd", "even") %}',
      '{{ cls.next() }}{{ cls.next() }}{{ cls.current }}',
      '{{ cls.reset() }}{{ cls.next() }}',
    ].join('')),
    'oddevenevenodd',
  );
  assert.equal(
    engine.render([
      '{% set separator = joiner("|") %}',
      'a{{ separator() }}b{{ separator() }}c{{ separator() }}',
    ].join('')),
    'ab|c|',
  );
});

test('implements the closed Nunjucks filter and test standard library', () => {
  const engine = createEngine({ cookiecutterCompat: true });
  const filterCases: Array<readonly [string, string]> = [
    ['{{ -3 | abs }}', '3'],
    ['{{ [1,2,3] | batch(2, 0) | dump }}', '[[1,2],[3]]'],
    ['{{ "hELLO" | capitalize }}', 'Hello'],
    ['[{{ "x" | center(3) }}]', '[ x ]'],
    ['{{ missing | default("fallback") }}|{{ "" | d("fallback", true) }}', 'fallback|fallback'],
    ['{{ {"b":2,"A":1} | dictsort | dump }}', '[["A",1],["b",2]]'],
    ['{{ {"value":[1,true]} | dump }}', '{"value":[1,true]}'],
    ['{{ "<x>" | e }}|{{ "<x>" | forceescape }}', '&lt;x&gt;|&lt;x&gt;'],
    ['{{ [1,2] | first }}:{{ [1,2] | last }}', '1:2'],
    ['{{ "1.5x" | float(2) }}:{{ "ff" | int(0, 16) }}', '1.5:255'],
    ['{{ [{"k":"a"},{"k":"a"}] | groupby("k") | dump }}', '{"a":[{"k":"a"},{"k":"a"}]}'],
    ['{{ "a\\nb" | indent(2, true) }}', '  a\n  b'],
    ['{{ [1,2] | join("-") }}', '1-2'],
    ['{{ [1,2] | length }}:{{ {"a":1} | length }}:{{ "😀" | length }}', '2:1:1'],
    ['{{ "ab" | list | dump }}', '["a","b"]'],
    ['{{ "ABC" | lower }}:{{ "abc" | upper }}', 'abc:ABC'],
    ['{{ "a\\nb" | nl2br }}', 'a<br />\nb'],
    ['{{ [7] | random }}', '7'],
    ['{{ [1,2,3,4] | select("even") | join }}:{{ [1,2,3,4] | reject("even") | join }}', '24:13'],
    ['{{ rows | selectattr("ok") | join(",", "name") }}:{{ rows | rejectattr("ok") | join(",", "name") }}', 'a:c'],
    ['{{ "a-a-a" | replace("a", "b", 2) }}', 'b-b-a'],
    ['{{ "ab" | reverse }}:{{ [1,2] | reverse | join }}', 'ba:21'],
    ['{{ 1.25 | round(1, "ceil") }}', '1.3'],
    ['{{ [1,2,3,4,5] | slice(2) | dump }}', '[[1,2,3],[4,5]]'],
    ['{{ [3,1,2] | sort | join }}', '123'],
    ['{{ 12 | string }}', '12'],
    ['{{ " <b>Hello</b>   world " | striptags }}', 'Hello world'],
    ['{{ [1,2,3] | sum }}', '6'],
    ['{{ "hello WORLD" | title }}', 'Hello World'],
    ['[{{ " x " | trim }}]', '[x]'],
    ['{{ "one two three" | truncate(7, false, "…") }}', 'one two…'],
    ['{{ "a b" | urlencode }}', 'a%20b'],
    ['{{ "https://example.com" | urlize }}', '<a href="https://example.com">https://example.com</a>'],
    ['{{ "one, two" | wordcount }}', '2'],
    ['{{ "<b>safe</b>" | safe }}', '<b>safe</b>'],
  ];
  const context = {
    rows: [{ name: 'a', ok: true }, { name: 'c', ok: false }],
  };
  for (const [source, expected] of filterCases) {
    let output: string | undefined;
    assert.doesNotThrow(() => {
      output = engine.render(source, context);
    }, source);
    assert.equal(output, expected, source);
  }

  const testCases: Array<readonly [string, string]> = [
    ['{% macro fn() %}{% endmacro %}{{ fn is callable }}', 'true'],
    ['{{ value is defined }}:{{ missing is undefined }}', 'true:true'],
    ['{{ 6 is divisibleby(3) }}', 'true'],
    ['{{ "x" | safe is escaped }}', 'true'],
    ['{{ 2 is equalto(2) }}:{{ 2 is eq(2) }}:{{ 2 is sameas(2) }}', 'true:true:true'],
    ['{{ 2 is even }}:{{ 3 is odd }}', 'true:true'],
    ['{{ 0 is falsy }}:{{ 1 is truthy }}', 'true:true'],
    ['{{ 2 is ge(2) }}:{{ 3 is gt(2) }}:{{ 3 is greaterthan(2) }}', 'true:true:true'],
    ['{{ [1] is iterable }}:{{ {"a":1} is mapping }}', 'true:true'],
    ['{{ 2 is le(2) }}:{{ 1 is lt(2) }}:{{ 1 is lessthan(2) }}', 'true:true:true'],
    ['{{ "abc" is lower }}:{{ "ABC" is upper }}', 'true:true'],
    ['{{ 1 is ne(2) }}:{{ None is null }}', 'true:true'],
    ['{{ 1 is number }}:{{ "x" is string }}', 'true:true'],
  ];
  for (const [source, expected] of testCases) {
    let output: string | undefined;
    assert.doesNotThrow(() => {
      output = engine.render(source, { value: 1 });
    }, source);
    assert.equal(output, expected, source);
  }
  const shared = {};
  assert.equal(
    engine.render('{{ left is sameas(right) }}', { left: shared, right: shared }),
    'true',
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

test('matches all upstream Jinja array slice cases', () => {
  const engine = createEngine({ cookiecutterCompat: true });
  const context = { arr: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], n: 1 };
  const cases: Array<readonly [string, string]> = [
    ['arr[1:4]', 'bcd'],
    ['arr[n:n+3]', 'bcd'],
    ['arr[3:]', 'defgh'],
    ['arr[-3:]', 'fgh'],
    ['arr[:4]', 'abcd'],
    ['arr[:-3]', 'abcde'],
    ['arr[::2]', 'aceg'],
    ['arr[::-1]', 'hgfedcba'],
    ['arr[4::-1]', 'edcba'],
    ['arr[-5::-1]', 'dcba'],
    ['arr[:3:-1]', 'hgfe'],
    ['arr[1::2]', 'bdfh'],
    ['arr[1:7:2]', 'bdf'],
  ];
  for (const [expression, expected] of cases) {
    assert.equal(
      engine.render(`{% for i in ${expression} %}{{ i }}{% endfor %}`, context),
      expected,
      expression,
    );
  }
});

test('matches applicable upstream runtime edge cases', () => {
  const engine = createEngine({ cookiecutterCompat: true });
  assert.equal(
    engine.render([
      '{% macro foo(bar, baz) %}{{ bar }} {{ baz }}{% endmacro %}',
      '{{ foo("hello", nosuchvar) }}',
    ].join('')),
    'hello ',
  );
  assert.equal(
    engine.render([
      '{% macro foo(bar, baz) %}{{ bar }} {{ baz.qux }}{% endmacro %}',
      '{{ foo("hello", noProto) }}',
    ].join(''), { noProto: Object.assign(Object.create(null), { qux: 'world' }) }),
    'hello world',
  );
  assert.throws(
    () => engine.render('{% block repeated %}a{% endblock %}{% block repeated %}b{% endblock %}'),
    /more than once/,
  );
  assert.throws(() => engine.render('{{ 1 in 2 }}'), /Membership requires/);
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
    () => engine.render('${{ value }}', { value: 'node' }, { limits: { astNodes: 2 } }),
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
  assert.throws(
    () => engine.render('${{ (((value))) }}', { value: 1 }, { limits: { nestingDepth: 2 } }),
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
