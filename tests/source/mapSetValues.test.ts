import assert from 'node:assert/strict';
import test from 'node:test';
import nunjucks from 'nunjucks';

import {
  createTemplateRenderer,
  TemplateRenderError,
} from '../../src/index.ts';
import { maximumSafeValueEntries } from '../../src/runtime/value.ts';

interface ContainerContext {
  readonly map: Map<unknown, unknown>;
  readonly set: Set<unknown>;
  readonly emptyMap: Map<unknown, unknown>;
  readonly emptySet: Set<unknown>;
  readonly key: { id: string };
  readonly aliasMap: Map<unknown, unknown>;
  readonly otherMap: Map<unknown, unknown>;
  readonly aliasSet: Set<unknown>;
  readonly otherSet: Set<unknown>;
  readonly nan: number;
  readonly nanMap: Map<number, string>;
  readonly nanSet: Set<number>;
}

const compatibilityCases = [
  {
    id: 'type-tests-and-length',
    source: [
      '{{ map.size }}|{{ map|length }}|{{ map is mapping }}|{{ map is iterable }}|',
      '{{ set.size }}|{{ set|length }}|{{ set is mapping }}|{{ set is iterable }}',
    ].join(''),
    expected: '3|3|true|true|3|3|false|true',
  },
  {
    id: 'ordered-looping',
    source: [
      '{% for key,value in map %}',
      '[{{ key|dump }}={{ value|dump }}:{{ loop.index }}/{{ loop.length }}]',
      '{% else %}empty{% endfor %}|',
      '{% for value in set %}',
      '[{{ value|dump }}:{{ loop.index }}/{{ loop.length }}]',
      '{% else %}empty{% endfor %}',
    ].join(''),
    expected: [
      '["first"=1:1/3][2="second":2/3][{"id":"key"}="object":3/3]|',
      '["first":1/3][2:2/3][{"id":"key"}:3/3]',
    ].join(''),
  },
  {
    id: 'empty-loop-alternates',
    source: [
      '{% for key,value in emptyMap %}bad{% else %}map-empty{% endfor %}|',
      '{% for value in emptySet %}bad{% else %}set-empty{% endfor %}',
    ].join(''),
    expected: 'map-empty|set-empty',
  },
  {
    id: 'query-methods-and-object-identity',
    source: [
      '{{ map.get("first") }}|{{ map.get("missing")|dump }}|{{ map.has(2) }}|',
      '{{ map.get(key) }}|{{ set.has(2) }}|{{ set.has(key) }}',
    ].join(''),
    expected: '1||true|object|true|true',
  },
  {
    id: 'iterator-producing-methods',
    source: [
      '{% for key in map.keys() %}[{{ key|dump }}]{% endfor %}|',
      '{% for value in map.values() %}[{{ value|dump }}]{% endfor %}|',
      '{% for key,value in map.entries() %}',
      '[{{ key|dump }}={{ value|dump }}]{% endfor %}|',
      '{% for value in set.values() %}[{{ value|dump }}]{% endfor %}|',
      '{% for first,second in set.entries() %}',
      '[{{ first|dump }}={{ second|dump }}]{% endfor %}',
    ].join(''),
    expected: [
      '["first"][2][{"id":"key"}]|[1]["second"]["object"]|',
      '["first"=1][2="second"][{"id":"key"}="object"]|',
      '["first"][2][{"id":"key"}]|',
      '["first"="first"][2=2][{"id":"key"}={"id":"key"}]',
    ].join(''),
  },
  {
    id: 'map-mutations',
    source: [
      '{% set returned=map.set("third",3) %}',
      '{{ returned === map }}|{{ aliasMap.size }}|{{ map.get("third") }}|',
      '{{ map.delete("first") }}|{{ map.delete("missing") }}|',
      '{% for key,value in aliasMap %}[{{ key|dump }}={{ value|dump }}]{% endfor %}|',
      '{% set ignored=map.clear() %}{{ map.size }}',
    ].join(''),
    expected: [
      'true|4|3|true|false|',
      '[2="second"][{"id":"key"}="object"]["third"=3]|0',
    ].join(''),
  },
  {
    id: 'set-mutations',
    source: [
      '{% set returned=set.add("third") %}',
      '{{ returned === set }}|{{ aliasSet.size }}|{{ set.has("third") }}|',
      '{{ set.delete("first") }}|{{ set.delete("missing") }}|',
      '{% for value in aliasSet %}[{{ value|dump }}]{% endfor %}|',
      '{% set ignored=set.clear() %}{{ set.size }}',
    ].join(''),
    expected: [
      'true|4|true|true|false|',
      '[2][{"id":"key"}]["third"]|0',
    ].join(''),
  },
  {
    id: 'delete-and-reinsert-order',
    source: [
      '{% set ignored=map.delete("first") %}{% set ignored=map.set("first",9) %}',
      '{% for key,value in map %}[{{ key|dump }}={{ value|dump }}]{% endfor %}|',
      '{% set ignored=set.delete("first") %}{% set ignored=set.add("first") %}',
      '{% for value in set %}[{{ value|dump }}]{% endfor %}',
    ].join(''),
    expected: [
      '[2="second"][{"id":"key"}="object"]["first"=9]|',
      '[2][{"id":"key"}]["first"]',
    ].join(''),
  },
  {
    id: 'closed-identity',
    source: [
      '{{ map === aliasMap }}|{{ map === otherMap }}|',
      '{{ set === aliasSet }}|{{ set === otherSet }}',
    ].join(''),
    expected: 'true|false|true|false',
  },
  {
    id: 'method-extraction-and-computed-names',
    source: [
      '{% set get=map.get %}{% set add=set.add %}',
      '{{ get("first") }}|{{ add("new") === set }}|{{ set.has("new") }}|',
      '{{ get is callable }}|{{ add is callable }}|',
      '{{ map["get"]("first") }}|{{ set["has"](2) }}',
    ].join(''),
    expected: '1|true|true|true|true|1|true',
  },
  {
    id: 'json-shape',
    source: '{{ map|dump }}|{{ set|dump }}',
    expected: '{}|{}',
  },
  {
    id: 'same-value-zero-keys-and-values',
    source: [
      '{{ nanMap.size }}|{{ nanMap.get(nan) }}|{{ nanMap.get(0) }}|',
      '{{ nanSet.size }}|{{ nanSet.has(nan) }}|{{ nanSet.has(0) }}',
    ].join(''),
    expected: '2|nan|zero|2|true|true',
  },
] as const;

test('matches Nunjucks Map and Set value behavior', () => {
  const oracle = new nunjucks.Environment(null, { autoescape: false });
  for (const case_ of compatibilityCases) {
    assert.equal(
      oracle.renderString(case_.source, createContainerContext()),
      case_.expected,
      `${case_.id} Nunjucks oracle`,
    );
  }

  for (const cookiecutterCompat of [false, true]) {
    const renderer = createTemplateRenderer({ cookiecutterCompat });
    for (const case_ of compatibilityCases) {
      const source = cookiecutterCompat
        ? case_.source
        : case_.source.replaceAll('{{', '${{');
      assert.equal(
        renderer.render(source, createContainerContext() as never),
        case_.expected,
        `${case_.id} ${cookiecutterCompat ? 'Cookiecutter' : 'default'}`,
      );
    }
  }
});

test('keeps Map and Set aliases and mutations local to one render', () => {
  const renderer = createTemplateRenderer();
  const values = [1];
  const map = new Map<unknown, unknown>([
    ['one', 1],
    ['values', values],
  ]);
  const set = new Set<unknown>(['one']);
  const context = { map, aliasMap: map, set, aliasSet: set, values };
  const source = [
    '{% set ignored=map.set("two",2) %}',
    '{% set ignored=set.add("two") %}',
    '{% set ignored=map.get("values").push(2) %}',
    '${{ aliasMap.size }}|${{ aliasSet.size }}|${{ map.get("two") }}|',
    '${{ set.has("two") }}|${{ map.get("values")|dump }}|${{ values|dump }}',
  ].join('');
  const expected = '3|2|2|true|[1,2]|[1,2]';

  assert.equal(renderer.render(source, context as never), expected);
  assert.equal(renderer.render(source, context as never), expected);
  assert.deepEqual(Array.from(map.entries()), [['one', 1], ['values', values]]);
  assert.deepEqual(Array.from(set.values()), ['one']);
  assert.deepEqual(values, [1]);

  const prepared = renderer.prepareContext(context as never);
  assert.equal(renderer.render(source, prepared), expected);
  assert.equal(renderer.render(source, prepared), expected);
  assert.equal(renderer.render('${{ map.has("two") }}|${{ set.has("two") }}', prepared), 'false|false');
  assert.throws(
    () => prepared.withValue(['map', 'nested'], 'blocked'),
    /is not a record/,
  );
});

test('discards Map and Set mutations after a failed render', () => {
  const events: string[] = [];
  const renderer = createTemplateRenderer({
    globals: {
      fail() {
        events.push('fail');
        throw new Error('expected failure');
      },
      later() {
        events.push('later');
        return 'later';
      },
    },
  });
  const map = new Map([['one', 1]]);
  const set = new Set(['one']);
  const source = [
    '{% set ignored=map.set("two",2) %}',
    '{% set ignored=set.add("two") %}',
    '${{ fail() }}${{ later() }}',
  ].join('');

  assert.throws(
    () => renderer.render(source, { map, set } as never),
    TemplateRenderError,
  );
  assert.deepEqual(events, ['fail']);
  assert.deepEqual(Array.from(map.entries()), [['one', 1]]);
  assert.deepEqual(Array.from(set.values()), ['one']);
  assert.equal(
    renderer.render(
      '${{ map.has("two") }}|${{ set.has("two") }}',
      { map, set } as never,
    ),
    'false|false',
  );
});

test('copies Map and Set values through capabilities and renderValue', () => {
  const globalMap = new Map([['value', 'global']]);
  const globalSet = new Set(['global']);
  const renderer = createTemplateRenderer({
    globals: {
      globalMap: globalMap as never,
      globalSet: globalSet as never,
      provideMap() {
        return new Map([['value', 'provided']]) as never;
      },
      provideSet() {
        return new Set(['provided']) as never;
      },
      inspectMap(value) {
        assert.ok(value instanceof Map);
        value.set('host-only', true);
        return value.size;
      },
      inspectSet(value) {
        assert.ok(value instanceof Set);
        value.add('host-only');
        return value.size;
      },
    },
  });
  const source = [
    '{% set map=provideMap() %}{% set set=provideSet() %}',
    '${{ globalMap.get("value") }}|${{ globalSet.has("global") }}|',
    '${{ inspectMap(map) }}|${{ map.has("host-only") }}|',
    '${{ inspectSet(set) }}|${{ set.has("host-only") }}',
  ].join('');

  assert.equal(renderer.render(source), 'global|true|2|false|2|false');
  assert.deepEqual(Array.from(globalMap.entries()), [['value', 'global']]);
  assert.deepEqual(Array.from(globalSet.values()), ['global']);

  const contextMap = new Map([['value', 1]]);
  const contextSet = new Set([1]);
  const renderedMap = renderer.renderValue('${{ value }}', { value: contextMap } as never);
  const renderedSet = renderer.renderValue('${{ value }}', { value: contextSet } as never);
  assert.ok(renderedMap instanceof Map);
  assert.ok(renderedSet instanceof Set);
  assert.notEqual(renderedMap, contextMap);
  assert.notEqual(renderedSet, contextSet);
  assert.deepEqual(Array.from(renderedMap.entries()), [['value', 1]]);
  assert.deepEqual(Array.from(renderedSet.values()), [1]);
  renderedMap.set('changed', true);
  renderedSet.add(2);
  assert.equal(
    renderer.render(
      '${{ map.has("changed") }}|${{ set.has(2) }}',
      { map: contextMap, set: contextSet } as never,
    ),
    'false|false',
  );
});

test('rejects unsafe Map and Set boundaries without invoking host behavior', () => {
  const renderer = createTemplateRenderer();
  let trapCalls = 0;
  const traps: ProxyHandler<Map<unknown, unknown>> = {
    get() {
      trapCalls += 1;
      throw new Error('get trap must not run');
    },
    getOwnPropertyDescriptor() {
      trapCalls += 1;
      throw new Error('descriptor trap must not run');
    },
    getPrototypeOf() {
      trapCalls += 1;
      throw new Error('prototype trap must not run');
    },
    ownKeys() {
      trapCalls += 1;
      throw new Error('ownKeys trap must not run');
    },
  };
  const mapProxy = new Proxy(new Map(), traps);
  const setProxy = new Proxy(new Set(), traps as never);
  const revokedMap = Proxy.revocable(new Map(), {});
  const revokedSet = Proxy.revocable(new Set(), {});
  revokedMap.revoke();
  revokedSet.revoke();
  for (const value of [mapProxy, setProxy, revokedMap.proxy, revokedSet.proxy]) {
    assert.throws(
      () => renderer.render('clean', { value } as never),
      TypeError,
    );
    assert.equal(trapCalls, 0);
    assert.equal(renderer.render('clean'), 'clean');
  }

  class CustomMap extends Map<unknown, unknown> {}
  class CustomSet extends Set<unknown> {}
  for (const value of [new CustomMap(), new CustomSet()]) {
    assert.throws(
      () => renderer.render('clean', { value } as never),
      TypeError,
    );
  }

  let getterCalls = 0;
  const mapWithProperty = Object.defineProperty(new Map(), 'entries', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'unsafe';
    },
  });
  const setWithProperty = Object.defineProperty(new Set(), 'values', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'unsafe';
    },
  });
  for (const value of [mapWithProperty, setWithProperty]) {
    assert.throws(
      () => renderer.render('clean', { value } as never),
      TypeError,
    );
  }
  assert.equal(getterCalls, 0);

  let iteratorCalls = 0;
  const iterable = {
    [Symbol.iterator]() {
      iteratorCalls += 1;
      return [1, 2][Symbol.iterator]();
    },
  };
  function* generator(): Generator<number> {
    iteratorCalls += 1;
    yield 1;
  }
  for (const value of [iterable, generator()]) {
    assert.throws(
      () => renderer.render('clean', { value } as never),
      TypeError,
    );
  }
  assert.equal(iteratorCalls, 0);

  const cyclicMap = new Map<unknown, unknown>();
  cyclicMap.set('self', cyclicMap);
  const cyclicSet = new Set<unknown>();
  cyclicSet.add(cyclicSet);
  for (const value of [cyclicMap, cyclicSet]) {
    assert.throws(
      () => renderer.render('clean', { value } as never),
      /Cyclic template values/,
    );
  }

  for (const reserved of ['constructor', 'prototype', '__proto__']) {
    assert.throws(
      () => renderer.render('clean', {
        value: new Map([[reserved, 'blocked']]),
      } as never),
      /reserved/,
    );
  }

  let laterCalls = 0;
  const capabilityRenderer = createTemplateRenderer({
    globals: {
      unsafe() {
        return mapProxy as never;
      },
      later() {
        laterCalls += 1;
        return 'later';
      },
    },
  });
  assert.throws(
    () => capabilityRenderer.render('${{ unsafe() }}${{ later() }}'),
    TemplateRenderError,
  );
  assert.equal(trapCalls, 0);
  assert.equal(laterCalls, 0);
  assert.equal(capabilityRenderer.render('clean'), 'clean');
});

test('keeps Map and Set methods inside the sealed callable boundary', () => {
  const events: string[] = [];
  const renderer = createTemplateRenderer({
    globals: {
      callback() {
        events.push('callback');
        return 1;
      },
      observe() {
        events.push('observe');
        return 'observed';
      },
      later() {
        events.push('later');
        return 'later';
      },
    },
  });
  const rejectedSources = [
    '${{ map.forEach(callback()) }}${{ later() }}',
    '${{ set.forEach(callback()) }}${{ later() }}',
    '${{ map.set("callable",callback) }}${{ later() }}',
    '${{ set.add(callback) }}${{ later() }}',
    '${{ observe(map.get) }}${{ later() }}',
    '${{ observe(set.add) }}${{ later() }}',
    '${{ map.constructor() }}${{ later() }}',
    '${{ set.constructor() }}${{ later() }}',
  ];

  for (const source of rejectedSources) {
    assert.throws(
      () => renderer.render(source, {
        map: new Map([['value', 1]]),
        set: new Set([1]),
      } as never),
      TemplateRenderError,
      source,
    );
    assert.deepEqual(events, [], source);
    assert.equal(renderer.render('clean'), 'clean');
  }
});

test('rejects reserved Map keys after safe-string coercion', () => {
  const events: string[] = [];
  const renderer = createTemplateRenderer({
    globals: {
      observe() {
        events.push('observe');
        return 'observed';
      },
    },
  });

  for (const reserved of ['constructor', 'prototype', '__proto__']) {
    assert.throws(
      () => renderer.render(
        `{% set ignored=map.set(${JSON.stringify(reserved)}|safe,1) %}` +
          '${{ observe(map) }}',
        { map: new Map() } as never,
      ),
      TemplateRenderError,
      reserved,
    );
    assert.deepEqual(events, [], reserved);
    assert.equal(renderer.render('clean'), 'clean');
  }
});

test('bounds copied Map and Set entries', () => {
  const renderer = createTemplateRenderer();
  const map = new Map<number, number>();
  const set = new Set<number>();
  for (let index = 0; index < maximumSafeValueEntries; index += 1) {
    map.set(index, index);
    set.add(index);
  }
  assert.equal(renderer.render('clean', { value: map } as never), 'clean');
  assert.equal(renderer.render('clean', { value: set } as never), 'clean');

  map.set(maximumSafeValueEntries, maximumSafeValueEntries);
  set.add(maximumSafeValueEntries);
  assert.throws(
    () => renderer.render('clean', { value: map } as never),
    RangeError,
  );
  assert.throws(
    () => renderer.render('clean', { value: set } as never),
    RangeError,
  );
  assert.equal(renderer.render('clean'), 'clean');
});

function createContainerContext(): ContainerContext {
  const key = { id: 'key' };
  const map = new Map<unknown, unknown>([
    ['first', 1],
    [2, 'second'],
    [key, 'object'],
  ]);
  const set = new Set<unknown>(['first', 2, key]);
  return {
    map,
    set,
    emptyMap: new Map(),
    emptySet: new Set(),
    key,
    aliasMap: map,
    otherMap: new Map(map),
    aliasSet: set,
    otherSet: new Set(set),
    nan: Number.NaN,
    nanMap: new Map([[Number.NaN, 'nan'], [-0, 'zero']]),
    nanSet: new Set([Number.NaN, Number.NaN, -0, 0]),
  };
}
