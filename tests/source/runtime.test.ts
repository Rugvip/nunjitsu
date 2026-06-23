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

test('matches Nunjucks record loop planning and multi-target destructuring', () => {
  const engineCalls: string[] = [];
  const oracleCalls: string[] = [];
  const engine = createEngine({
    globals: {
      records() {
        engineCalls.push('records');
        return { a: 1 };
      },
      body() {
        engineCalls.push('body');
        return '';
      },
    },
  });
  const oracle = new nunjucks.Environment(undefined, { autoescape: false });
  oracle.addGlobal('records', () => {
    oracleCalls.push('records');
    return { a: 1 };
  });
  oracle.addGlobal('body', () => {
    oracleCalls.push('body');
    return '';
  });
  const metadataSource = [
    '{% for value in record %}',
    '[${{ value | dump }}|${{ loop.index }}|${{ loop.index0 }}|',
    '${{ loop.revindex }}|${{ loop.revindex0 }}|${{ loop.first }}|',
    '${{ loop.last }}|${{ loop.length | dump }}]',
    '{% else %}ELSE{% endfor %}',
  ].join('');
  const recordCases = [
    { record: { a: 1 }, expected: 'ELSE' },
    { record: { 0: 'A', length: 0 }, expected: 'ELSE' },
    { record: { 0: 'A', length: '0' }, expected: '' },
    { record: { 0: 'A', length: -1 }, expected: '' },
    {
      record: { 0: 'A', 1: 'B', length: 2 },
      expected: '["A"|1|0|2|1|true|false|2]["B"|2|1|1|0|false|true|2]',
    },
    {
      record: { 0: 'A', 1: 'B', length: '2' },
      expected: '["A"|1|0|2|1|true|false|"2"]["B"|2|1|1|0|false|true|"2"]',
    },
    {
      record: { 0: 'A', 1: 'B', length: 1.5 },
      expected: '["A"|1|0|1.5|0.5|true|false|1.5]["B"|2|1|0.5|-0.5|false|false|1.5]',
    },
    {
      record: { 0: 'A', length: 2 },
      expected: '["A"|1|0|2|1|true|false|2][|2|1|1|0|false|true|2]',
    },
  ];
  for (const { record, expected } of recordCases) {
    assert.equal(
      oracle.renderString(metadataSource.replaceAll('${{', '{{'), { record }),
      expected,
    );
    assert.equal(engine.render(metadataSource, { record }), expected);
  }

  const standardLoopSource = [
    '{% for value in ["a","b"] %}',
    '[${{ value }},${{ loop.index }},${{ loop.index0 }},${{ loop.revindex }},',
    '${{ loop.revindex0 }},${{ loop.first }},${{ loop.last }},${{ loop.length }}]',
    '{% else %}BAD{% endfor %}|',
    '{% for value in [] %}BAD{% else %}EMPTY{% endfor %}|',
    '{% for value in missing %}BAD{% else %}MISSING{% endfor %}|',
    '{% for value in holder.missing %}BAD{% else %}PROPERTY{% endfor %}|',
    '{% for value in null %}BAD{% else %}NULL{% endfor %}|',
    '{% for row in [[1,2],[3,4]] %}',
    '[${{ loop.index }}:${{ loop.revindex }}:',
    '{% for value in row %}${{ loop.index }}.${{ loop.revindex }}=${{ value }};{% endfor %}]',
    '{% endfor %}',
  ].join('');
  const standardLoopContext = { holder: {} };
  assert.equal(
    engine.render(standardLoopSource, standardLoopContext),
    oracle.renderString(standardLoopSource.replaceAll('${{', '{{'), standardLoopContext),
  );

  const literalSource = [
    '{% for value in {"0":"literal", length:1} %}',
    '${{ value }}:${{ loop.length }}',
    '{% else %}ELSE{% endfor %}',
  ].join('');
  assert.equal(
    engine.render(literalSource),
    oracle.renderString(literalSource.replaceAll('${{', '{{'), {}),
  );

  const capabilitySource = [
    '{% for value in records() %}${{ body() }}',
    '{% else %}DENY{% endfor %}',
  ].join('');
  assert.equal(
    engine.render(capabilitySource),
    oracle.renderString(capabilitySource.replaceAll('${{', '{{'), {}),
  );
  assert.deepEqual(engineCalls, ['records']);
  assert.deepEqual(oracleCalls, engineCalls);

  const multiTargetSource = [
    '{% for a,b,c in record %}',
    '[R:${{ a | dump }},${{ b | dump }},${{ c | dump }},${{ loop.length | dump }}]',
    '{% endfor %}|',
    '{% for a,b in "😀x" %}',
    '[P:${{ a | dump }},${{ b | dump }},${{ loop.length | dump }}]',
    '{% endfor %}|',
    '{% for a,b in "xy" | safe %}',
    '[S:${{ a | dump }},${{ b | dump }},${{ loop.length | dump }}]',
    '{% endfor %}|',
    '{% for a,b in [["x","y"],"ab","cd" | safe,{"0":"m","1":"n"},12,true] %}',
    '[A:${{ a | dump }},${{ b | dump }}]',
    '{% endfor %}',
  ].join('');
  const multiTargetContext = { record: { x: 1, y: 2 } };
  assert.equal(
    engine.render(multiTargetSource, multiTargetContext),
    oracle.renderString(multiTargetSource.replaceAll('${{', '{{'), multiTargetContext),
  );

  assert.throws(
    () => engine.render(
      '{% for value in record %}{% set consumed = value %}{% endfor %}',
      { record: { length: Number.POSITIVE_INFINITY } },
      { limits: { workUnits: 100 } },
    ),
    NunjitsuLimitError,
  );
  assert.equal(engine.render('clean'), 'clean');
});

test('rejects invalid targets and nullish destructuring before loop bodies execute', () => {
  let engineCalls = 0;
  let oracleCalls = 0;
  const engine = createEngine({
    globals: {
      privileged() {
        engineCalls += 1;
        return 1;
      },
    },
  });
  const oracle = new nunjucks.Environment(undefined, { autoescape: false });
  oracle.addGlobal('privileged', () => {
    oracleCalls += 1;
    return 1;
  });
  const invalidTargets = [
    '{% for [a,b] in [privileged()] %}${{ privileged() }}{% endfor %}${{ privileged() }}',
    '{% for [a,[b,c]] in [[1,[2,3]]] %}${{ privileged() }}{% endfor %}${{ privileged() }}',
    '{% for (a) in [privileged()] %}${{ privileged() }}{% endfor %}${{ privileged() }}',
    '{% set [a,b] = [privileged(),2] %}${{ privileged() }}',
    '{% set [a,b] %}${{ privileged() }}{% endset %}${{ privileged() }}',
  ];
  for (const source of invalidTargets) {
    assert.throws(() => engine.render(source), NunjitsuRenderError);
    assert.throws(() => oracle.renderString(source.replaceAll('${{', '{{'), {}));
    assert.equal(engineCalls, 0);
    assert.equal(oracleCalls, 0);
    assert.equal(engine.render('clean'), 'clean');
  }

  const validTargets = [
    '{% for value in [1] %}${{ value }}{% endfor %}',
    '{% for first,second in [[1,2]] %}${{ first }}${{ second }}{% endfor %}',
    '{% set first,second = 3 %}${{ first }}${{ second }}',
  ];
  for (const source of validTargets) {
    assert.equal(
      engine.render(source),
      oracle.renderString(source.replaceAll('${{', '{{'), {}),
    );
  }

  const sparse = Array<null>(1);
  const nullishCases = [
    { source: '{% for first,second in [null] %}${{ privileged() }}{% endfor %}' },
    { source: '{% for first,second in [missing] %}${{ privileged() }}{% endfor %}' },
    {
      source: '{% for first,second in values %}${{ privileged() }}{% endfor %}',
      context: { values: sparse },
    },
  ];
  for (const { source, context } of nullishCases) {
    assert.throws(() => engine.render(source, context), NunjitsuRenderError);
    assert.throws(() => oracle.renderString(source.replaceAll('${{', '{{'), context ?? {}));
    assert.equal(engineCalls, 0);
    assert.equal(oracleCalls, 0);
    assert.equal(engine.render('clean'), 'clean');
  }
});

test('matches Nunjucks canonical global and fresh member callable identities', () => {
  let engineCalls = 0;
  let oracleCalls = 0;
  const engine = createEngine({
    globals: {
      p() {
        engineCalls += 1;
        return 'P';
      },
      q() {
        throw new Error('q must not be called');
      },
    },
  });
  const oracle = new nunjucks.Environment(undefined, { autoescape: false });
  oracle.addGlobal('p', () => {
    oracleCalls += 1;
    return 'P';
  });
  oracle.addGlobal('q', () => {
    throw new Error('q must not be called');
  });
  const source = [
    '${{ p == p }}|${{ p === p }}|${{ p != p }}|${{ p !== p }}|',
    '${{ p is sameas(p) }}|${{ p in [p] }}|${{ p not in [p] }}|',
    '${{ p === q }}|${{ p !== q }}|',
    '${{ range === range }}|${{ cycler === cycler }}|${{ joiner === joiner }}|',
    '${{ cycler(1,2) !== cycler(1,2) }}|${{ joiner() !== joiner() }}|',
    '{% set alias = p %}',
    '${{ alias === alias }}|${{ alias === p }}|${{ alias in [p] }}|',
    '{% for loopAlias in [p] %}${{ loopAlias === p }}|{% endfor %}',
    '{% macro aliasCheck(value) %}${{ value === p }}{% endmacro %}',
    '${{ aliasCheck(p) }}|',
    '{% set record = {fn:p} %}{% set values = [p] %}',
    '${{ record.fn !== record.fn }}|${{ record.fn !== p }}|',
    '${{ values[0] !== values[0] }}|${{ values[0] !== p }}|',
    '${{ record.fn() }}${{ values[0]() }}|',
    '{% set inner = {fn:p} %}{% set nestedRecord = {inner:inner} %}',
    '{% set nestedValues = [[p]] %}',
    '${{ nestedRecord.inner.fn !== nestedRecord.inner.fn }}|',
    '${{ nestedValues[0][0] !== nestedValues[0][0] }}|',
    '${{ nestedRecord.inner.fn() }}${{ nestedValues[0][0]() }}|',
    '{% macro macroValue() %}M{% endmacro %}',
    '{% set macroRecord = {fn:macroValue} %}{% set macroValues = [macroValue] %}',
    '${{ macroValue === macroValue }}|${{ macroRecord.fn !== macroRecord.fn }}|',
    '${{ macroRecord.fn !== macroValue }}|${{ macroValues[0] !== macroValues[0] }}|',
    '${{ macroRecord.fn() }}${{ macroValues[0]() }}|',
    '{% set builtinRecord = {fn:range} %}{% set builtinValues = [range] %}',
    '${{ builtinRecord.fn !== builtinRecord.fn }}|${{ builtinRecord.fn !== range }}|',
    '${{ builtinValues[0] !== builtinValues[0] }}|',
    '${{ builtinRecord.fn(1,3) | join("") }}${{ builtinValues[0](1,3) | join("") }}|',
    '{% set cycle = cycler("a","b") %}',
    '${{ cycle.next !== cycle.next }}|${{ cycle.reset !== cycle.reset }}|',
    '{% set next = cycle.next %}${{ next === next }}|${{ next !== cycle.next }}|',
    '{% set callableCycle = cycler(p) %}{% set ignored = callableCycle.next() %}',
    '${{ callableCycle.current !== callableCycle.current }}|',
    '${{ callableCycle.current !== p }}|${{ callableCycle.current() }}|',
    '{% if p !== p %}${{ p() }}{% endif %}',
    '{% if p not in [p] %}${{ p() }}{% endif %}',
  ].join('');
  const expected = oracle.renderString(source.replaceAll('${{', '{{'), {});
  assert.equal(engine.render(source), expected);
  assert.equal(engineCalls, 5);
  assert.equal(oracleCalls, engineCalls);
  assert.equal(engine.render(source), expected);
  assert.equal(engineCalls, 10);
  assert.equal(oracleCalls, 5);
});

test('uses strict closed identity for switch matching and preserves evaluation order', () => {
  const engineCalls: string[] = [];
  const oracleCalls: string[] = [];
  let privilegedCalls = 0;
  let oraclePrivilegedCalls = 0;
  const engine = createEngine({
    globals: {
      p() {
        throw new Error('p must not be called');
      },
      mark(value) {
        if (typeof value === 'string') {
          engineCalls.push(value);
        }
        return value;
      },
      privileged() {
        privilegedCalls += 1;
        return 'WRONG';
      },
      fail() {
        engineCalls.push('fail');
        throw new Error('expected failure');
      },
      later() {
        engineCalls.push('later');
        return 'later';
      },
    },
  });
  const oracle = new nunjucks.Environment(undefined, { autoescape: false });
  oracle.addGlobal('p', () => {
    throw new Error('p must not be called');
  });
  oracle.addGlobal('mark', (value: unknown) => {
    if (typeof value === 'string') {
      oracleCalls.push(value);
    }
    return value;
  });
  oracle.addGlobal('privileged', () => {
    oraclePrivilegedCalls += 1;
    return 'WRONG';
  });
  oracle.addGlobal('fail', () => {
    oracleCalls.push('fail');
    throw new Error('expected failure');
  });
  oracle.addGlobal('later', () => {
    oracleCalls.push('later');
    return 'later';
  });

  const primitiveSource = [
    '{% switch 1 %}{% case "1" %}A{% default %}D{% endswitch %}|',
    '{% switch 1 %}{% case true %}A{% default %}D{% endswitch %}|',
    '{% switch 0 %}{% case false %}A{% default %}D{% endswitch %}|',
    '{% switch null %}{% case missing %}A{% default %}D{% endswitch %}|',
    '{% switch missing %}{% case null %}A{% default %}D{% endswitch %}|',
    '{% switch "x" | safe %}{% case "x" %}A{% default %}D{% endswitch %}|',
    '{% set safeValue = "x" | safe %}',
    '{% switch safeValue %}{% case safeValue %}M{% default %}D{% endswitch %}|',
    '{% switch 0 / 0 %}{% case 0 / 0 %}A{% default %}D{% endswitch %}|',
    '{% switch 0 %}{% case -0 %}M{% default %}D{% endswitch %}',
  ].join('');
  assert.equal(
    engine.render(primitiveSource),
    oracle.renderString(primitiveSource.replaceAll('${{', '{{'), {}),
  );

  const referenceSource = [
    '{% set array = [1] %}{% set arrayAlias = array %}',
    '{% set record = {x:1} %}{% set recordAlias = record %}',
    '{% switch array %}{% case arrayAlias %}A{% default %}D{% endswitch %}|',
    '{% switch array %}{% case [1] %}WRONG{% default %}D{% endswitch %}|',
    '{% switch record %}{% case recordAlias %}R{% default %}D{% endswitch %}|',
    '{% switch record %}{% case {x:1} %}WRONG{% default %}D{% endswitch %}|',
    '{% set callableRecord = {fn:p} %}',
    '{% switch p %}{% case p %}P{% default %}D{% endswitch %}|',
    '{% switch range %}{% case range %}B{% default %}D{% endswitch %}|',
    '{% switch callableRecord.fn %}{% case p %}WRONG{% default %}D{% endswitch %}|',
    '{% macro macroValue() %}M{% endmacro %}{% set macroRecord = {fn:macroValue} %}',
    '{% switch macroValue %}{% case macroValue %}M{% default %}D{% endswitch %}|',
    '{% switch macroRecord.fn %}{% case macroValue %}WRONG{% default %}D{% endswitch %}',
  ].join('');
  assert.equal(
    engine.render(referenceSource),
    oracle.renderString(referenceSource.replaceAll('${{', '{{'), {}),
  );

  const orderSource = [
    '{% switch mark("value") %}',
    '{% case mark("a") %}A',
    '{% case mark("value") %}',
    '{% case mark("skip") %}F',
    '{% default %}D{% endswitch %}',
  ].join('');
  assert.equal(
    engine.render(orderSource),
    oracle.renderString(orderSource.replaceAll('${{', '{{'), {}),
  );
  assert.deepEqual(engineCalls, ['value', 'a', 'value']);
  assert.deepEqual(oracleCalls, engineCalls);

  const guardedSource = [
    '{% switch 1 %}{% case "1" %}${{ privileged() }}',
    '{% default %}DENY{% endswitch %}',
  ].join('');
  assert.equal(engine.render(guardedSource), 'DENY');
  assert.equal(
    oracle.renderString(guardedSource.replaceAll('${{', '{{'), {}),
    'DENY',
  );
  assert.equal(privilegedCalls, 0);
  assert.equal(oraclePrivilegedCalls, 0);

  const failingSource = [
    'before{% switch "value" %}',
    '{% case fail() %}WRONG',
    '{% case later() %}WRONG',
    '{% default %}D{% endswitch %}',
  ].join('');
  assert.throws(() => engine.render(failingSource), NunjitsuRenderError);
  assert.throws(() => oracle.renderString(failingSource.replaceAll('${{', '{{'), {}));
  assert.deepEqual(engineCalls, ['value', 'a', 'value', 'fail']);
  assert.deepEqual(oracleCalls, engineCalls);
  assert.equal(engine.render('clean'), 'clean');
});

test('matches Nunjucks declaration ordering and post-keyword positional calls', () => {
  const engineOrder: string[] = [];
  const oracleOrder: string[] = [];
  const engineGlobalArguments: unknown[][] = [];
  const oracleGlobalArguments: unknown[][] = [];
  const engineFilterArguments: unknown[][] = [];
  const oracleFilterArguments: unknown[][] = [];
  let engineDefaultCalls = 0;
  let oracleDefaultCalls = 0;
  const engine = createEngine({
    filters: {
      inspectFilter(input, ...arguments_) {
        engineFilterArguments.push([input, ...arguments_]);
        return `${input}:${arguments_[0]}`;
      },
    },
    globals: {
      defaultValue() {
        engineDefaultCalls += 1;
        return 'DEFAULT';
      },
      inspect(...arguments_) {
        engineGlobalArguments.push(Array.from(arguments_));
        return arguments_[0];
      },
      mark(value) {
        if (typeof value === 'string') {
          engineOrder.push(value);
        }
        return value;
      },
    },
  });
  const oracle = new nunjucks.Environment(undefined, { autoescape: false });
  oracle.addFilter('inspectFilter', (input: unknown, ...arguments_: unknown[]) => {
    oracleFilterArguments.push([input, ...arguments_]);
    return `${input}:${arguments_[0]}`;
  });
  oracle.addGlobal('defaultValue', () => {
    oracleDefaultCalls += 1;
    return 'DEFAULT';
  });
  oracle.addGlobal('inspect', (...arguments_: unknown[]) => {
    oracleGlobalArguments.push(Array.from(arguments_));
    return arguments_[0];
  });
  oracle.addGlobal('mark', (value: unknown) => {
    if (typeof value === 'string') {
      oracleOrder.push(value);
    }
    return value;
  });

  const declarationSource = [
    '{% macro first(a=1,b) %}[${{ a | dump }},${{ b | dump }}]{% endmacro %}',
    '${{ first(2,3) }}|${{ first(b=4,5) }}|',
    '{% macro second(a,b=1,c) %}[${{ a | dump }},${{ b | dump }},${{ c | dump }}]{% endmacro %}',
    '${{ second(2,3,4) }}|${{ second(b=5,6) }}|',
    '{% macro third(a=1,b=2,c) %}[${{ a | dump }},${{ b | dump }},${{ c | dump }}]{% endmacro %}',
    '${{ third(3,4,5) }}|${{ third(a=6,7) }}|',
    '{% macro duplicate(a,a=2) %}[${{ a | dump }}]{% endmacro %}',
    '${{ duplicate(1,3) }}|${{ duplicate(a=4,5) }}|',
    '{% macro duplicateDefault(a,a=defaultValue()) %}[${{ a | dump }}]{% endmacro %}',
    '${{ duplicateDefault(8) }}|',
    '{% macro literalName(true=1) %}${{ true }}{% endmacro %}${{ literalName() }}|',
    '{% macro defaults(a=defaultValue(),b) %}[${{ a }},${{ b }}]{% endmacro %}',
    '${{ defaults() }}|${{ defaults(missing,2) }}|${{ defaults(a=missing) }}|',
    '{% macro pair(a,b) %}[${{ a | dump }},${{ b | dump }}]{% endmacro %}',
    '${{ pair(a=1,2) }}|${{ pair(b=1,2) }}|',
    '{% macro wrap() %}${{ caller(2,3) }}{% endmacro %}',
    '{% call(a=1,b) wrap() %}[${{ a | dump }},${{ b | dump }}]{% endcall %}|',
    '{% call(a,b=1,c) wrap() %}[${{ a | dump }},${{ b | dump }},${{ c | dump }}]{% endcall %}',
  ].join('');
  assert.equal(
    engine.render(declarationSource),
    oracle.renderString(declarationSource.replaceAll('${{', '{{'), {}),
  );
  assert.equal(engineDefaultCalls, 2);
  assert.equal(oracleDefaultCalls, engineDefaultCalls);

  const capabilitySource = [
    '${{ inspect(option=mark("option"),mark("value")) }}|',
    '${{ "input" | inspectFilter(option=mark("filter-option"),mark("filter-value")) }}',
  ].join('');
  assert.equal(
    engine.render(capabilitySource),
    oracle.renderString(capabilitySource.replaceAll('${{', '{{'), {}),
  );
  assert.deepEqual(engineOrder, ['value', 'option', 'filter-value', 'filter-option']);
  assert.deepEqual(oracleOrder, engineOrder);
  assert.deepEqual(engineGlobalArguments, [['value']]);
  assert.equal(oracleGlobalArguments[0]?.[0], 'value');
  assert.deepEqual(engineFilterArguments, [['input', 'filter-value']]);
  assert.deepEqual(oracleFilterArguments[0]?.slice(0, 2), ['input', 'filter-value']);

  assert.throws(
    () => engine.render(
      '{% macro value(a=1,b,c=3) %}${{ a }}{% endmacro %}',
      {},
      { limits: { astNodes: 1 } },
    ),
    NunjitsuLimitError,
  );
  assert.equal(engine.render('clean'), 'clean');
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

test('preserves closed value types through range, sum, and joiner', () => {
  const engine = createEngine({ cookiecutterCompat: true });
  const oracle = new nunjucks.Environment(undefined, { autoescape: false });
  const sources = [
    '{{ range(1, missing) | dump }}|{{ range(2, missing, -1) | dump }}|',
    '{{ range(false, 1) | dump }}|{{ range(null, 2) | dump }}|{{ range("1", 4) | dump }}|',
    '{{ range(0, 3, false) | dump }}|{{ range(1, 4, 1) | dump }}|{{ range(1, 4, "1") | dump }}|',
    '{{ [1,2] | sum(null, "1") | dump }}|{{ [1,"2"] | sum | dump }}|',
    '{{ [[1],[2]] | sum | dump }}|{{ [{"x":1}] | sum | dump }}|',
    '{{ [null] | sum | dump }}|{{ [true,false] | sum | dump }}|{{ [missing] | sum | dump }}|',
    '{% set separator = joiner(1) %}{% set ignored = separator() %}{% set value = separator() %}',
    '{{ value | dump }}:{{ value is number }}:{{ value === 1 }}|',
    '{% set separator = joiner(true) %}{% set ignored = separator() %}{% set value = separator() %}',
    '{{ value | dump }}:{{ value is number }}|',
    '{% set separator = joiner([1,2]) %}{% set ignored = separator() %}{% set value = separator() %}',
    '{{ value | dump }}:{{ value is iterable }}|',
    '{% set separator = joiner({"x":1}) %}{% set ignored = separator() %}{% set value = separator() %}',
    '{{ value | dump }}:{{ value is mapping }}|',
    '{% set separator = joiner(r/x/) %}{% set ignored = separator() %}{% set value = separator() %}',
    '{{ value is mapping }}|',
    '{% set separator = joiner("x" | safe) %}{% set ignored = separator() %}{% set value = separator() %}',
    '{{ value is string }}:{{ value is escaped }}',
  ];
  const source = sources.join('');
  assert.equal(engine.render(source), oracle.renderString(source, {}));
  assert.equal(engine.render('clean'), 'clean');
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

test('matches closed standard-library coercion and input domains', () => {
  const engine = createEngine({ cookiecutterCompat: true });
  const oracle = new nunjucks.Environment(undefined, { autoescape: false });
  const outcome = (render: () => string): readonly ['output', string] | readonly ['error'] => {
    try {
      return ['output', render()];
    } catch {
      return ['error'];
    }
  };
  const inputs = [
    'missing',
    'null',
    'false',
    'true',
    '1',
    '"x"',
    '[1]',
    '{"x":1}',
    'r/x/',
  ];
  const collectionFilters = [
    'batch(2)',
    'first',
    'last',
    'join',
    'random',
    'reverse',
    'slice(2)',
    'sort',
    'sum',
    'groupby("x")',
    'select',
    'reject',
    'selectattr("x")',
    'rejectattr("x")',
  ];
  for (const filter of collectionFilters) {
    for (const input of inputs) {
      const source = `{{ (${input}) | ${filter} | dump }}`;
      assert.deepEqual(
        outcome(() => engine.render(source)),
        outcome(() => oracle.renderString(source, {})),
        `${input} | ${filter}`,
      );
    }
  }

  for (const input of [...inputs, '"x" | safe']) {
    const source = `{{ (${input}) | length | dump }}`;
    assert.deepEqual(
      outcome(() => engine.render(source)),
      outcome(() => oracle.renderString(source, {})),
      `${input} | length`,
    );
  }

  const urlencodeInputs = [
    '"a b"',
    '[["a", "b"]]',
    '[1]',
    '["ab"]',
    '[[1]]',
    '[{"0":"a", "1":"b"}]',
    '{"a":1}',
    'missing',
    'null',
    'false',
    'true',
    '1',
    'r/x/',
  ];
  for (const input of urlencodeInputs) {
    const source = `{{ (${input}) | urlencode | dump }}`;
    assert.deepEqual(
      outcome(() => engine.render(source)),
      outcome(() => oracle.renderString(source, {})),
      `${input} | urlencode`,
    );
  }

  const textSources = [
    '{{ missing | string }}',
    '{{ null | string }}',
    '{{ false | capitalize | dump }}',
    '{{ false | center(4) | dump }}',
    '{{ false | indent(2) | dump }}',
    '{{ false | lower | dump }}',
    '{{ false | striptags | dump }}',
    '{{ false | title | dump }}',
    '{{ false | truncate(2) | dump }}',
    '{{ false | upper | dump }}',
    '{{ false | wordcount | dump }}',
    '{{ false | replace("a", "b") | dump }}',
    '{{ null | nl2br | dump }}',
    '{{ true | trim }}',
    '{{ {} | lower }}',
    '{{ true | urlize }}',
  ];
  for (const source of textSources) {
    assert.deepEqual(
      outcome(() => engine.render(source)),
      outcome(() => oracle.renderString(source, {})),
      source,
    );
  }

  const testInputs = [
    'missing', 'null', 'false', 'true', '1', '"x"', '[1]', '{"x":1}', 'r/x/',
  ];
  for (const testName of ['lower', 'upper', 'iterable', 'mapping']) {
    for (const input of testInputs) {
      const source = `{{ (${input}) is ${testName} }}`;
      assert.deepEqual(
        outcome(() => engine.render(source)),
        outcome(() => oracle.renderString(source, {})),
        `${input} is ${testName}`,
      );
    }
  }

  const safeStringSource = [
    '{{ "x" | safe | batch(2) | dump }}|',
    '{{ "x" | safe | first | dump }}|',
    '{{ "x" | safe | last | dump }}|',
    '{{ "x" | safe | random | dump }}|',
    '{{ "x" | safe | reverse | dump }}|',
    '{{ "x" | safe | slice(2) | dump }}|',
    '{{ "x" | safe | sort | dump }}|',
    '{{ "x" | safe | select | dump }}|',
    '{{ "x" | safe | reject | dump }}|',
    '{{ "x" | safe is lower }}:{{ "x" | safe is upper }}:',
    '{{ "x" | safe is iterable }}:{{ "x" | safe is mapping }}',
  ].join('');
  assert.equal(
    engine.render(safeStringSource),
    '[["x"]]|"x"|"x"|"x"|"x"|["x",""]|["x"]|["x"]|[]|false:false:true:true',
  );

  const keywordAndGlobalSource = [
    '[{{ "x" | center(4) }}]|',
    '{{ "ff" | int(base=16) }}:',
    '{{ "bad" | int(default=7, base=10) }}|',
    '{{ "" | default("fallback", boolean=true) }}|',
    '{% set separator = joiner(false) %}{{ separator() }}{{ separator() }}|',
    '{{ range(0, 3, 0) | join }}',
  ].join('');
  assert.equal(
    engine.render(keywordAndGlobalSource),
    oracle.renderString(keywordAndGlobalSource, {}),
  );

  const resetValues: unknown[] = [];
  const oracleResetValues: unknown[] = [];
  const resetEngine = createEngine({
    cookiecutterCompat: true,
    filters: {
      inspect(value) {
        resetValues.push(value);
        return value === undefined ? 'undefined' : 'other';
      },
    },
  });
  oracle.addFilter('inspect', (value: unknown) => {
    oracleResetValues.push(value);
    return value === undefined ? 'undefined' : 'other';
  });
  const resetSource = '{% set values = cycler(1) %}{{ values.reset() | inspect }}';
  assert.equal(resetEngine.render(resetSource), oracle.renderString(resetSource, {}));
  assert.deepEqual(resetValues, [undefined]);
  assert.deepEqual(oracleResetValues, resetValues);
  assert.equal(engine.render('clean'), 'clean');
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

test('matches Nunjucks mixed-operator grouping and evaluation order', () => {
  const calls: string[] = [];
  const oracleCalls: string[] = [];
  let privilegedCalls = 0;
  let oraclePrivilegedCalls = 0;
  const engine = createEngine({
    globals: {
      mark(name, value) {
        if (typeof name === 'string') {
          calls.push(name);
        }
        return value;
      },
      privileged() {
        privilegedCalls += 1;
        return 'privileged';
      },
      fail() {
        calls.push('fail');
        throw new Error('expected failure');
      },
    },
  });
  const oracle = new nunjucks.Environment(undefined, { autoescape: false });
  oracle.addGlobal('mark', (name: string, value: unknown) => {
    oracleCalls.push(name);
    return value;
  });
  oracle.addGlobal('privileged', () => {
    oraclePrivilegedCalls += 1;
    return 'privileged';
  });
  oracle.addGlobal('fail', () => {
    oracleCalls.push('fail');
    throw new Error('expected failure');
  });

  const operationSource = [
    '${{ mark("power-a", 2) ** mark("power-b", 3) ** mark("power-c", 2) }}|',
    '${{ mark("concat-a", 1) ~ mark("concat-b", 2) + mark("concat-c", 3) }}|',
    '${{ mark("floor-a", 20) * mark("floor-b", 6) // mark("floor-c", 4) }}|',
    '${{ mark("group-a", 1) ~ (mark("group-b", 2) + mark("group-c", 3)) }}',
  ].join('');
  const expectedOutput = oracle.renderString(operationSource.replaceAll('${{', '{{'), {});
  assert.equal(engine.render(operationSource), expectedOutput);
  assert.equal(expectedOutput, '64|123|20|15');
  assert.deepEqual(calls, oracleCalls);
  assert.deepEqual(calls, [
    'power-a', 'power-b', 'power-c',
    'concat-a', 'concat-b', 'concat-c',
    'floor-a', 'floor-b', 'floor-c',
    'group-a', 'group-b', 'group-c',
  ]);

  const branchSource = [
    '{% if 2 ** 3 ** 2 == 64 %}${{ privileged() }}{% endif %}|',
    '{% if 1 ~ 2 + 3 == "123" %}${{ privileged() }}{% endif %}|',
    '{% if 20 * 6 // 4 == 20 %}${{ privileged() }}{% endif %}',
  ].join('');
  assert.equal(
    engine.render(branchSource),
    oracle.renderString(branchSource.replaceAll('${{', '{{'), {}),
  );
  assert.equal(privilegedCalls, 3);
  assert.equal(oraclePrivilegedCalls, 3);

  calls.length = 0;
  oracleCalls.length = 0;
  const failureSource = '${{ mark("before", 1) + fail() + mark("after", 2) }}';
  assert.throws(() => engine.render(failureSource), NunjitsuRenderError);
  assert.throws(() => oracle.renderString(failureSource.replaceAll('${{', '{{'), {}));
  assert.deepEqual(calls, ['before', 'fail']);
  assert.deepEqual(oracleCalls, calls);
  assert.equal(engine.render('clean'), 'clean');
});

test('matches Nunjucks comparison, membership, test, and not grouping', () => {
  const calls: string[] = [];
  const oracleCalls: string[] = [];
  let privilegedCalls = 0;
  let oraclePrivilegedCalls = 0;
  const engine = createEngine({
    globals: {
      mark(name, value) {
        if (typeof name === 'string') {
          calls.push(name);
        }
        return value;
      },
      privileged() {
        privilegedCalls += 1;
        return '';
      },
    },
  });
  const oracle = new nunjucks.Environment(undefined, { autoescape: false });
  oracle.addGlobal('mark', (name: string, value: unknown) => {
    oracleCalls.push(name);
    return value;
  });
  oracle.addGlobal('privileged', () => {
    oraclePrivilegedCalls += 1;
    return '';
  });

  const equalityOperators = ['==', '!=', '===', '!=='];
  const relationalOperators = ['<', '<=', '>', '>='];
  const mixedComparisons: string[] = [];
  for (const equality of equalityOperators) {
    for (const relational of relationalOperators) {
      mixedComparisons.push(`2 ${equality} 1 ${relational} 1`);
      mixedComparisons.push(`1 ${relational} 2 ${equality} true`);
    }
  }
  mixedComparisons.push('3 > 2 > 1');
  const comparisonSource = mixedComparisons
    .map(expression => `\${{ ${expression} }}`)
    .join('|');
  assert.equal(
    engine.render(comparisonSource),
    oracle.renderString(comparisonSource.replaceAll('${{', '{{'), {}),
  );

  const groupingExpressions = [
    'false == 1 in [1]',
    '1 == 1 is number',
    '1 is number in [true]',
    '(1 is number) in [true]',
    'not 1 in [true]',
    'not 1 not in [2]',
    'not 1 + 1',
    'not 4 - 2',
    'not 0 * 0',
    'not 4 / 2',
    'not 5 % 2',
    'not 0 ~ 1',
    'not 1 == 2',
    'not 1 != 2',
    'not 1 === 1',
    'not 1 !== 2',
    'not 1 < 2',
    'not 1 <= 2',
    'not 2 > 1',
    'not 2 >= 1',
    'not 5 // 2',
    'not 2 ** 3',
    'not 1 | int',
    'not 1 is number',
    'not (1 + 1)',
    'not not 1 + 1',
  ];
  const groupingSource = groupingExpressions
    .map(expression => `\${{ ${expression} }}`)
    .join('|');
  assert.equal(
    engine.render(groupingSource),
    oracle.renderString(groupingSource.replaceAll('${{', '{{'), {}),
  );

  const orderSource = [
    '${{ mark("a", 2) == mark("b", 1) < mark("c", 1) }}|',
    '${{ not mark("d", 0) * mark("e", 0) }}|',
    '${{ not mark("f", 1) in [mark("g", true)] }}',
  ].join('');
  assert.equal(
    engine.render(orderSource),
    oracle.renderString(orderSource.replaceAll('${{', '{{'), {}),
  );
  assert.deepEqual(calls, oracleCalls);
  assert.deepEqual(calls, ['a', 'b', 'c', 'd', 'e', 'f', 'g']);

  const branchSource = [
    '{% if 2 == 1 < 1 %}${{ privileged() }}{% endif %}',
    '{% if not 1 == 2 %}${{ privileged() }}{% endif %}',
    '{% if not 0 * 0 %}${{ privileged() }}{% endif %}',
  ].join('');
  assert.equal(
    engine.render(branchSource),
    oracle.renderString(branchSource.replaceAll('${{', '{{'), {}),
  );
  assert.equal(privilegedCalls, 0);
  assert.equal(oraclePrivilegedCalls, 0);

  for (const expression of [
    '1 in [1] == true',
    '1 not in [2] == true',
  ]) {
    const source = `before\${{ ${expression} }}\${{ privileged() }}`;
    assert.throws(() => engine.render(source), NunjitsuRenderError);
    assert.throws(() => oracle.renderString(source.replaceAll('${{', '{{'), {}));
    assert.equal(privilegedCalls, 0);
    assert.equal(oraclePrivilegedCalls, 0);
    assert.equal(engine.render('clean'), 'clean');
  }

  assert.throws(
    () => engine.render('${{ not 2 == 1 < 1 }}', {}, { limits: { astNodes: 1 } }),
    NunjitsuLimitError,
  );
  assert.throws(
    () => engine.render('${{ not 2 == 1 < 1 }}', {}, { limits: { workUnits: 1 } }),
    NunjitsuLimitError,
  );
  assert.equal(engine.render('clean'), 'clean');
});

test('rejects Nunjucks-invalid nested conditionals and dictionary keys before evaluation', () => {
  const calls: string[] = [];
  const oracleCalls: string[] = [];
  const capabilities = {
    a() {
      calls.push('a');
      return 'a';
    },
    b() {
      calls.push('b');
      return 'b';
    },
    c() {
      calls.push('c');
      return 'c';
    },
    f(value: unknown) {
      calls.push('f');
      return value as never;
    },
    privileged() {
      calls.push('privileged');
      return '';
    },
  };
  const engine = createEngine({ globals: capabilities });
  const oracle = new nunjucks.Environment(undefined, { autoescape: false });
  for (const name of ['a', 'b', 'c', 'f', 'privileged'] as const) {
    oracle.addGlobal(name, (...arguments_: unknown[]) => {
      oracleCalls.push(name);
      if (name === 'f') {
        return arguments_[0];
      }
      return name === 'privileged' ? '' : name;
    });
  }

  const invalidConditionalSources = [
    '${{ a() if false else b() if true else c() }}',
    '${{ [a() if false else b() if true else c()] }}',
    '${{ {"x": a() if false else b() if true else c()} | dump }}',
    '${{ f(a() if false else b() if true else c()) }}',
    '${{ "x" | default(a() if false else b() if true else c()) }}',
    '{% set x = a() if false else b() if true else c() %}${{ x }}',
    '{% if a() if false else b() if true else c() %}x{% endif %}',
  ];
  for (const source of invalidConditionalSources) {
    assert.throws(() => engine.render(source), NunjitsuRenderError);
    assert.throws(() => oracle.renderString(source.replaceAll('${{', '{{'), {}));
    assert.deepEqual(calls, []);
    assert.deepEqual(oracleCalls, []);
    assert.equal(engine.render('clean'), 'clean');
  }

  const parenthesizedSource = '${{ a() if false else (b() if true else c()) }}';
  assert.equal(
    engine.render(parenthesizedSource),
    oracle.renderString(parenthesizedSource.replaceAll('${{', '{{'), {}),
  );
  assert.deepEqual(calls, ['b']);
  assert.deepEqual(oracleCalls, calls);
  calls.length = 0;
  oracleCalls.length = 0;

  for (const key of ['1', '1.5', 'true', 'false', 'null', 'none']) {
    const source = `before\${{ {${key}: 2} | dump }}\${{ privileged() }}`;
    assert.throws(() => engine.render(source), NunjitsuRenderError);
    assert.throws(() => oracle.renderString(source.replaceAll('${{', '{{'), {}));
    assert.deepEqual(calls, []);
    assert.deepEqual(oracleCalls, []);
    assert.equal(engine.render('clean'), 'clean');
  }

  const validDictionarySource = '${{ {name: 2, "label": 3} | dump }}';
  assert.equal(
    engine.render(validDictionarySource),
    oracle.renderString(validDictionarySource.replaceAll('${{', '{{'), {}),
  );
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

  const templateFailures = [
    'before${{ [] | batch(0) }}after',
    'before${{ [1] | dictsort }}after',
    'before${{ [{"key":"__proto__"}] | groupby("key") }}after',
    'before${{ "x" | center(1e309) }}after',
    'before${{ "' + String.fromCharCode(0xd800) + '" | urlencode }}after',
    'before${{ "x" | unknownFilter }}after',
  ];
  for (const source of templateFailures) {
    assert.throws(
      () => engine.render(source),
      error => (
        error instanceof NunjitsuRenderError &&
        error.phase === 'evaluate' &&
        error.code === 'evaluation_error' &&
        error.cause === undefined
      ),
      source,
    );
    assert.equal(engine.render('${{ value }}', { value: 'clean' }), 'clean');
  }
});
