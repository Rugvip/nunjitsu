import assert from 'node:assert/strict';
import test from 'node:test';
import nunjucks from 'nunjucks';

import {
  createEngine,
  NunjitsuLimitError,
  NunjitsuRenderError,
} from '../../src/index.ts';
import {
  RuntimeArray,
  RuntimeRecord,
  RuntimeRegex,
  RuntimeSafeString,
} from '../../src/runtime/value.ts';

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
    '1:A:3;2:\ud83d:3;3:\ude00:3;first=1;second=2;',
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
    ['{{ [1,2] | length }}:{{ {"a":1} | length }}:{{ "😀" | length }}', '2:1:2'],
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

test('selects random values without consuming the host Math.random stream', t => {
  let mathRandomCalls = 0;
  t.mock.method(Math, 'random', () => {
    mathRandomCalls += 1;
    throw new Error('Math.random must not be called during rendering');
  });

  const engine = createEngine({ cookiecutterCompat: true });
  assert.equal(engine.render('{{ [] | random | default("empty") }}'), 'empty');
  assert.equal(engine.render('{{ ["only"] | random }}'), 'only');

  for (let iteration = 0; iteration < 20; iteration += 1) {
    const selected = engine.render('{{ ["a", "b", "c"] | random }}');
    assert.ok(['a', 'b', 'c'].includes(selected));
  }
  assert.equal(mathRandomCalls, 0);
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

test('uses UTF-16 code units consistently for string operations', () => {
  const engine = createEngine();
  const oracle = new nunjucks.Environment(undefined, { autoescape: false });
  const values = [
    'Ax',
    '😀',
    '😀x',
    '\ud83d',
    '\ude00',
    '😀🧪',
  ];
  const operationSource = [
    '${{ value | length }}|${{ value.length }}|',
    '{% for character in value %}[${{ loop.index }}/${{ loop.length }}=${{ character | dump }}]{% endfor %}|',
    '${{ value | list | dump }}|',
    '${{ value | first | dump }}:${{ value | last | dump }}|',
    '${{ value | reverse | dump }}|',
    '${{ value | replace("", "-") | dump }}:',
    '${{ value | replace("", "-", 2) | dump }}|',
    '${{ value[value | length] is undefined }}',
  ].join('');

  for (const value of values) {
    const context = { value, index: value.length - 1 };
    const operationOutput = engine.render(operationSource, context);
    assert.equal(
      operationOutput,
      oracle.renderString(operationSource.replaceAll('${{', '{{'), context),
      JSON.stringify(value),
    );
    assert.match(operationOutput, new RegExp(`^${value.length}\\|${value.length}\\|`));

    const codeUnits: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      codeUnits.push(value[index]!);
    }
    const constantLookups = codeUnits
      .map((unused, index) => `\${{ value[${index}] | dump }}`)
      .join(':');
    const lookupSource = `${constantLookups}|\${{ value[index] | dump }}`;
    assert.equal(
      engine.render(lookupSource, context),
      oracle.renderString(lookupSource.replaceAll('${{', '{{'), context),
      JSON.stringify(value),
    );

    const sliceSource = [
      '${{ value[0:2] | dump }}',
      '${{ value[-2:] | dump }}',
      '${{ value[1:-1] | dump }}',
      '${{ value[::2] | dump }}',
      '${{ value[::-1] | dump }}',
    ].join('|');
    const expectedSlices = [
      codeUnits.slice(0, 2),
      codeUnits.slice(-2),
      codeUnits.slice(1, -1),
      codeUnits.filter((unused, index) => index % 2 === 0),
      codeUnits.toReversed(),
    ].map(value_ => JSON.stringify(value_)).join('|');
    assert.equal(engine.render(sliceSource, context), expectedSlices, JSON.stringify(value));
  }

  let hostIteratorCalls = 0;
  const iteratorDescriptor = Object.getOwnPropertyDescriptor(
    String.prototype,
    Symbol.iterator,
  );
  const context = { value: '😀x', index: 2 };
  const expectedWithoutHostIteration = engine.render(operationSource, context);
  Object.defineProperty(String.prototype, Symbol.iterator, {
    configurable: true,
    value() {
      hostIteratorCalls += 1;
      throw new Error('String iteration protocol must not run');
    },
  });
  try {
    assert.equal(engine.render(operationSource, context), expectedWithoutHostIteration);
  } finally {
    if (iteratorDescriptor) {
      Object.defineProperty(String.prototype, Symbol.iterator, iteratorDescriptor);
    } else {
      Reflect.deleteProperty(String.prototype, Symbol.iterator);
    }
  }
  assert.equal(hostIteratorCalls, 0);
});

test('orders strings lexicographically by UTF-16 code units', () => {
  let privilegedCalls = 0;
  let oraclePrivilegedCalls = 0;
  const engine = createEngine({
    globals: {
      privileged() {
        privilegedCalls += 1;
        return 'PRIVILEGED';
      },
    },
  });
  const oracle = new nunjucks.Environment(undefined, { autoescape: false });
  oracle.addGlobal('privileged', () => {
    oraclePrivilegedCalls += 1;
    return 'PRIVILEGED';
  });
  const comparisonSource = [
    '${{ left < right }}:',
    '${{ left <= right }}:',
    '${{ left > right }}:',
    '${{ left >= right }}',
  ].join('');
  const pairs = [
    ['a', 'A'],
    ['A', 'a'],
    ['a', '1'],
    ['1', 'a'],
    ['é', 'z'],
    ['z', 'é'],
    ['😀', '🧪'],
    ['\ud83d', '\ude00'],
    ['é', 'e\u0301'],
    ['', 'a'],
    ['a', ''],
    ['equal', 'equal'],
  ] as const;
  for (const [left, right] of pairs) {
    const context = { left, right };
    assert.equal(
      engine.render(comparisonSource, context),
      oracle.renderString(comparisonSource.replaceAll('${{', '{{'), context),
      `${JSON.stringify(left)} compared with ${JSON.stringify(right)}`,
    );
  }

  const chainedSource = [
    '${{ first < middle < last }}:',
    '${{ first >= middle >= last }}:',
    '${{ 3 > 2 > 1 }}',
  ].join('');
  for (const context of [
    { first: 'A', middle: 'a', last: 'é' },
    { first: 'e\u0301', middle: 'é', last: '😀' },
    { first: 'a', middle: 'A', last: '1' },
  ]) {
    assert.equal(
      engine.render(chainedSource, context),
      oracle.renderString(chainedSource.replaceAll('${{', '{{'), context),
    );
  }

  const conditionalSource = [
    '{% if left < right %}${{ privileged() }}{% endif %}',
  ].join('');
  const context = { left: 'a', right: 'A' };
  assert.equal(engine.render(conditionalSource, context), '');
  assert.equal(
    oracle.renderString(conditionalSource.replaceAll('${{', '{{'), context),
    '',
  );
  assert.equal(privilegedCalls, 0);
  assert.equal(oraclePrivilegedCalls, 0);
  assert.equal(engine.render('clean'), 'clean');
});

test('implements closed strict and loose equality without host coercion', () => {
  let privilegedCalls = 0;
  let oraclePrivilegedCalls = 0;
  const engine = createEngine({
    globals: {
      privileged() {
        privilegedCalls += 1;
        return 'PRIVILEGED';
      },
    },
  });
  const oracle = new nunjucks.Environment(undefined, { autoescape: false });
  oracle.addGlobal('privileged', () => {
    oraclePrivilegedCalls += 1;
    return 'PRIVILEGED';
  });
  const comparisonSource = [
    '${{ left == right }}:',
    '${{ left != right }}:',
    '${{ left === right }}:',
    '${{ left !== right }}',
  ].join('');
  const pairs = [
    ['null and undefined', null, undefined],
    ['null and false', null, false],
    ['null and zero', null, 0],
    ['null and empty string', null, ''],
    ['undefined and false', undefined, false],
    ['undefined and zero', undefined, 0],
    ['undefined and empty string', undefined, ''],
    ['true and one', true, 1],
    ['false and zero', false, 0],
    ['numeric string and number', '1', 1],
    ['empty string and zero', '', 0],
    ['non-numeric string and zero', 'x', 0],
    ['NaN with itself', Number.NaN, Number.NaN],
    ['positive and negative zero', 0, -0],
  ] as const;
  for (const [label, left, right] of pairs) {
    const context = { left, right };
    assert.equal(
      engine.render(comparisonSource, context as never),
      oracle.renderString(comparisonSource.replaceAll('${{', '{{'), context),
      label,
    );
  }

  const identitySource = [
    '{% set safeA = "x" | safe %}',
    '{% set safeB = "x" | safe %}',
    '{% set arrayA = [] %}',
    '{% set arrayB = [] %}',
    '{% set recordA = {"value": 1} %}',
    '{% set recordB = {"value": 1} %}',
    '{% set callable = privileged %}',
    '${{ safeA == "x" }}:${{ safeA === "x" }}:${{ "x" == safeA }}:${{ "x" === safeA }}|',
    '${{ safeA == safeB }}:${{ safeA === safeB }}:${{ safeA == safeA }}:${{ safeA === safeA }}|',
    '${{ arrayA == arrayA }}:${{ arrayA === arrayA }}:${{ arrayA == arrayB }}:${{ arrayA === arrayB }}|',
    '${{ recordA == recordA }}:${{ recordA === recordA }}:${{ recordA == recordB }}:${{ recordA === recordB }}|',
    '${{ callable == callable }}:${{ callable === callable }}',
  ].join('');
  const expectedIdentities = oracle.renderString(
    identitySource.replaceAll('${{', '{{'),
    {},
  );
  assert.equal(engine.render(identitySource), expectedIdentities);
  assert.equal(privilegedCalls, 0);
  assert.equal(oraclePrivilegedCalls, 0);

  let coercionHookCalls = 0;
  const coercionKeys = ['valueOf', 'toString', Symbol.toPrimitive] as const;
  const descriptors = new Map<PropertyKey, PropertyDescriptor | undefined>();
  for (const key of coercionKeys) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(RuntimeSafeString.prototype, key));
    Object.defineProperty(RuntimeSafeString.prototype, key, {
      configurable: true,
      value() {
        coercionHookCalls += 1;
        throw new Error('Safe-string host coercion must not run');
      },
    });
  }
  try {
    assert.equal(engine.render(identitySource), expectedIdentities);
  } finally {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) {
        Object.defineProperty(RuntimeSafeString.prototype, key, descriptor);
      } else {
        Reflect.deleteProperty(RuntimeSafeString.prototype, key);
      }
    }
  }
  assert.equal(coercionHookCalls, 0);

  const conditionalSource = [
    '{% if null == false %}${{ privileged() }}{% endif %}',
    '{% if missing == 0 %}${{ privileged() }}{% endif %}',
    '{% switch null %}',
    '{% case false %}${{ privileged() }}',
    '{% default %}default',
    '{% endswitch %}',
  ].join('');
  assert.equal(engine.render(conditionalSource), 'default');
  assert.equal(
    oracle.renderString(conditionalSource.replaceAll('${{', '{{'), {}),
    'default',
  );
  assert.equal(privilegedCalls, 0);
  assert.equal(oraclePrivilegedCalls, 0);
  assert.equal(engine.render('clean'), 'clean');
});

test('uses centralized closed coercion for lookup, membership, grouping, and operators', () => {
  const engine = createEngine();
  const oracle = new nunjucks.Environment(undefined, { autoescape: false });
  const context = {
    obj: {
      undefined: 'undefined',
      null: 'null',
      false: 'false',
      true: 'true',
      0: 'zero',
      '': 'empty',
    },
    arr: ['zero', 'one'],
    text: 'ab',
  };
  const lookupSource = [
    '{% set safeLength = "length" | safe %}',
    '${{ obj[missing] }}:${{ obj[null] }}:${{ obj[false] }}:${{ obj[true] }}:',
    '${{ obj[0] }}:${{ obj[""] }}|',
    '${{ arr[null] is undefined }}:${{ arr[false] is undefined }}:',
    '${{ arr[""] is undefined }}:${{ arr["01"] is undefined }}:',
    '${{ arr["1.0"] is undefined }}:${{ arr[" 1 "] is undefined }}:',
    '${{ arr["1e0"] is undefined }}:${{ arr[-0] }}:${{ arr["1"] }}:',
    '${{ arr.length }}:${{ arr[safeLength] }}|',
    '${{ text[null] is undefined }}:${{ text[false] is undefined }}:',
    '${{ text[""] is undefined }}:${{ text["01"] is undefined }}:',
    '${{ text["1"] }}:${{ text.length }}:${{ text[safeLength] }}',
  ].join('');
  assert.equal(
    engine.render(lookupSource, context),
    oracle.renderString(lookupSource.replaceAll('${{', '{{'), context),
  );

  const membershipSource = [
    '{% set safeValue = "x" | safe %}',
    '${{ false in [0] }}:${{ missing in [null] }}:${{ safeValue in ["x"] }}|',
    '${{ missing in "" }}:${{ null in "" }}|',
    '${{ missing in obj }}:${{ null in obj }}:${{ false in obj }}:',
    '${{ true in obj }}:${{ 0 in obj }}',
  ].join('');
  assert.equal(
    engine.render(membershipSource, context),
    oracle.renderString(membershipSource.replaceAll('${{', '{{'), context),
  );

  const groupSource = [
    '${{ [',
    '{"key":null,"value":"null"},',
    '{"value":"undefined"},',
    '{"key":false,"value":"false"},',
    '{"key":0,"value":"zero"},',
    '{"key":"","value":"empty"}',
    '] | groupby("key") | dump }}',
  ].join('');
  assert.equal(
    engine.render(groupSource),
    oracle.renderString(groupSource.replaceAll('${{', '{{'), {}),
  );

  const operatorSource = [
    '${{ ([] + 1) | dump }}:${{ ([1] + 1) | dump }}:',
    '${{ ([1,2] + 1) | dump }}:${{ ({} + 1) | dump }}|',
    '${{ [] - 0 }}:${{ [1] - 0 }}:${{ +[] }}:${{ +[1] }}|',
    '${{ [] == 0 }}:${{ [1] == 1 }}:${{ {} == "[object Object]" }}:',
    '${{ [] < 1 }}|',
    '${{ (null ~ false) | dump }}:${{ (missing ~ null) | dump }}|',
    '${{ "10" is lt("2") }}:${{ "10" is le("2") }}:',
    '${{ "10" is gt("2") }}:${{ "10" is ge("2") }}|',
    '${{ (r/a+/gi ~ "") | dump }}:${{ r/a+/gi == "/a+/gi" }}|',
    '${{ null }}:${{ missing }}',
  ].join('');
  assert.equal(
    engine.render(operatorSource),
    oracle.renderString(operatorSource.replaceAll('${{', '{{'), {}),
  );

  const builtinLookupSource = [
    '{% set cycle = cycler("a", "b") %}',
    '{% set nextKey = "next" | safe %}',
    '${{ cycle[nextKey]() }}:${{ cycle[nextKey]() }}',
  ].join('');
  assert.equal(
    engine.render(builtinLookupSource),
    oracle.renderString(builtinLookupSource.replaceAll('${{', '{{'), {}),
  );
});

test('closed coercion controls capability branches and rejects callables', () => {
  const calls: string[] = [];
  const oracleCalls: string[] = [];
  let privilegedCalls = 0;
  let laterCalls = 0;
  const engine = createEngine({
    globals: {
      mark(name) {
        if (typeof name === 'string') {
          calls.push(name);
        }
        return null;
      },
      privileged() {
        privilegedCalls += 1;
        return 'privileged';
      },
      later() {
        laterCalls += 1;
        return 'later';
      },
    },
  });
  const oracle = new nunjucks.Environment(undefined, { autoescape: false });
  oracle.addGlobal('mark', (name: string) => {
    oracleCalls.push(name);
    return null;
  });
  const branchSource = [
    '{% set arr = ["present"] %}',
    '{% if arr[null] %}${{ mark("lookup") }}{% endif %}',
    '{% if false in [0] %}${{ mark("membership") }}{% endif %}',
    '{% if [] == 0 %}${{ mark("equality") }}{% endif %}',
    '{% if "10" is gt("2") %}${{ mark("relational") }}{% endif %}',
  ].join('');
  assert.equal(engine.render(branchSource), '');
  assert.equal(oracle.renderString(branchSource.replaceAll('${{', '{{'), {}), '');
  assert.deepEqual(calls, oracleCalls);
  assert.deepEqual(calls, ['equality']);

  const prototypes = [
    RuntimeSafeString.prototype,
    RuntimeArray.prototype,
    RuntimeRecord.prototype,
    RuntimeRegex.prototype,
  ];
  const coercionKeys = ['valueOf', 'toString', Symbol.toPrimitive] as const;
  const descriptors: Array<readonly [object, PropertyKey, PropertyDescriptor | undefined]> = [];
  let coercionHookCalls = 0;
  for (const prototype of prototypes) {
    for (const key of coercionKeys) {
      descriptors.push([prototype, key, Object.getOwnPropertyDescriptor(prototype, key)]);
      Object.defineProperty(prototype, key, {
        configurable: true,
        value() {
          coercionHookCalls += 1;
          throw new Error('Closed coercion must not invoke host hooks');
        },
      });
    }
  }
  try {
    assert.equal(
      engine.render([
        '{% set safeValue = "x" | safe %}',
        '${{ (safeValue ~ [1] ~ {"value": 1} ~ r/a/) | dump }}',
      ].join('')),
      '"x1[object Object]/a/"',
    );
  } finally {
    for (const [prototype, key, descriptor] of descriptors) {
      if (descriptor) {
        Object.defineProperty(prototype, key, descriptor);
      } else {
        Reflect.deleteProperty(prototype, key);
      }
    }
  }
  assert.equal(coercionHookCalls, 0);

  assert.throws(
    () => engine.render('${{ privileged ~ "" }}${{ later() }}'),
    error => error instanceof NunjitsuRenderError,
  );
  assert.equal(privilegedCalls, 0);
  assert.equal(laterCalls, 0);
  assert.equal(engine.render('clean'), 'clean');
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
    () => engine.render('valid', { invalid: new Date() as never }),
    error => error instanceof TypeError && !(error instanceof NunjitsuRenderError),
  );
  assert.throws(
    () => engine.render('valid', {}, { limits: { workUnits: -1 } }),
    error => error instanceof RangeError && !(error instanceof NunjitsuRenderError),
  );
  assert.throws(
    () => engine.render('too much work', {}, { limits: { workUnits: 0 } }),
    error => error instanceof NunjitsuLimitError,
  );

  assert.throws(
    () => engine.render('${{ broken( }}'),
    error => error instanceof NunjitsuRenderError,
  );
  assert.throws(
    () => engine.render('${{ value.toString() }}', { value: 'x' }),
    error => error instanceof NunjitsuRenderError,
  );

  const templateFailures: ReadonlyArray<{
    readonly source: string;
    readonly cause: ErrorConstructor;
  }> = [
    { source: 'before${{ [] | batch(0) }}after', cause: TypeError },
    { source: 'before${{ [1] | dictsort }}after', cause: TypeError },
    {
      source: 'before${{ [{"key":"__proto__"}] | groupby("key") }}after',
      cause: TypeError,
    },
    { source: 'before${{ "x" | center(1e309) }}after', cause: RangeError },
    {
      source: 'before${{ "' + String.fromCharCode(0xd800) + '" | urlencode }}after',
      cause: URIError,
    },
    { source: 'before${{ "x" | unknownFilter }}after', cause: Error },
  ];
  for (const { source, cause } of templateFailures) {
    assert.throws(
      () => engine.render(source),
      error => (
        error instanceof NunjitsuRenderError &&
        error.cause instanceof cause
      ),
      source,
    );
    assert.equal(engine.render('${{ value }}', { value: 'clean' }), 'clean');
  }
});
