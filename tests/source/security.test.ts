import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { inspect } from 'node:util';
import nunjucks from 'nunjucks';

import { createEngine, NunjitsuLimitError, NunjitsuRenderError } from '../../src/index.ts';
import { NunjitsuParseError, parseTemplate } from '../../src/parser/index.ts';
import { applyBuiltinFilter } from '../../src/runtime/builtins.ts';
import { RuntimeScope } from '../../src/runtime/scope.ts';
import {
  copyPublicValue,
  copyRuntimeContext,
  copyRuntimeValue,
  RuntimeArray,
  RuntimeRecord,
  RuntimeRegex,
  RuntimeSafeString,
  withRuntimeContextPath,
} from '../../src/runtime/value.ts';

const semanticNameCases = Object.freeze([
  { name: '__proto__', reserved: true },
  { name: 'constructor', reserved: true },
  { name: 'prototype', reserved: true },
  { name: 'toString', reserved: false },
  { name: 'valueOf', reserved: false },
  { name: 'hasOwnProperty', reserved: false },
  { name: 'toJSON', reserved: false },
  { name: '__defineGetter__', reserved: false },
  { name: '__defineSetter__', reserved: false },
  { name: '__lookupGetter__', reserved: false },
  { name: '__lookupSetter__', reserved: false },
  { name: '', reserved: false },
  { name: '0', reserved: false },
  { name: '01', reserved: false },
  { name: '東京', reserved: false },
  { name: 'segment.child', reserved: false },
  { name: 'x'.repeat(4_096), reserved: false },
]);

const bidiControlCharacters = Object.freeze([
  '\u061c',
  '\u200e',
  '\u200f',
  '\u202a',
  '\u202b',
  '\u202c',
  '\u202d',
  '\u202e',
  '\u2066',
  '\u2067',
  '\u2068',
  '\u2069',
]);

test('copies only plain data without invoking accessors or host behavior', () => {
  let getterCalls = 0;
  const withGetter = Object.defineProperty({}, 'secret', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'leaked';
    },
  });
  assert.throws(() => copyRuntimeValue(withGetter as never), /cannot contain accessors/);
  assert.equal(getterCalls, 0);

  class HostValue {
    value = 'host';
  }
  assert.throws(() => copyRuntimeValue(new HostValue() as never), /Only plain records/);
  assert.throws(
    () => copyRuntimeValue(Object.assign([1], { extra: 2 }) as never),
    /cannot have custom properties/,
  );
  assert.throws(
    () => copyRuntimeValue({ value: () => 'host' } as never),
    /Unsupported template value/,
  );
  assert.throws(
    () => copyRuntimeValue({ [Symbol('secret')]: 'host' } as never),
    /cannot contain symbol keys/,
  );
});

test('rejects proxy-backed values before invoking reflection traps', () => {
  let getPrototypeOfCalls = 0;
  let ownKeysCalls = 0;
  let descriptorCalls = 0;
  let laterCalls = 0;
  const trapFailure = { secret: 'must not be retained' };
  const traps = {
    getPrototypeOf() {
      getPrototypeOfCalls += 1;
      throw trapFailure;
    },
    ownKeys() {
      ownKeysCalls += 1;
      throw trapFailure;
    },
    getOwnPropertyDescriptor() {
      descriptorCalls += 1;
      throw trapFailure;
    },
  };
  const recordProxy = new Proxy({ value: 'blocked' }, traps);
  const arrayProxy = new Proxy([1, 2], traps);
  const revocable = Proxy.revocable({ value: 'blocked' }, traps);
  revocable.revoke();

  for (const value of [
    recordProxy,
    arrayProxy,
    revocable.proxy,
    { nested: recordProxy },
    [recordProxy],
  ]) {
    assert.throws(
      () => copyRuntimeValue(value),
      /Proxy objects cannot be used as template values/,
    );
  }

  const contextEngine = createEngine();
  assert.throws(
    () => contextEngine.render('clean', recordProxy),
    /Proxy objects cannot be used as template values/,
  );
  assert.throws(
    () => contextEngine.render('${{ nested }}', { nested: recordProxy }),
    /Proxy objects cannot be used as template values/,
  );
  assert.throws(
    () => contextEngine.prepareContext({ value: recordProxy }),
    /Proxy objects cannot be used as template values/,
  );
  const prepared = contextEngine.prepareContext({ steps: {} });
  assert.throws(
    () => prepared.withPath(['steps', 'unsafe'], revocable.proxy),
    /Proxy objects cannot be used as template values/,
  );
  assert.throws(
    () => createEngine({ globals: { unsafe: arrayProxy } }),
    /Proxy objects cannot be used as template values/,
  );

  const capabilityEngine = createEngine({
    filters: {
      proxyResult() {
        return recordProxy;
      },
    },
    globals: {
      proxyResult() {
        return recordProxy;
      },
      nestedProxyResult() {
        return { nested: recordProxy };
      },
      arrayProxyResult() {
        return arrayProxy;
      },
      revokedProxyResult() {
        return revocable.proxy;
      },
      later() {
        laterCalls += 1;
        return 'not reached';
      },
    },
  });
  for (const source of [
    '${{ "value" | proxyResult }}${{ later() }}',
    '${{ proxyResult() }}${{ later() }}',
    '${{ nestedProxyResult() }}${{ later() }}',
    '${{ arrayProxyResult() }}${{ later() }}',
    '${{ revokedProxyResult() }}${{ later() }}',
  ]) {
    let caught: NunjitsuRenderError | undefined;
    assert.throws(
      () => capabilityEngine.render(source),
      error => {
        if (!(error instanceof NunjitsuRenderError)) {
          return false;
        }
        caught = error;
        return error.message.includes(
          'failed: Proxy objects cannot be used as template values',
        );
      },
    );
    assert.equal(caught?.code, 'capability_error');
    assert.equal(caught?.cause, undefined);
    assert.equal(laterCalls, 0);
    assert.equal(capabilityEngine.render('clean'), 'clean');
  }

  assert.equal(getPrototypeOfCalls, 0);
  assert.equal(ownKeysCalls, 0);
  assert.equal(descriptorCalls, 0);
  assert.equal(
    contextEngine.render('${{ value | dump }}', { value: { items: [1, 2] } }),
    '{"items":[1,2]}',
  );
});

test('copying arrays does not invoke inherited host iteration hooks', () => {
  let getterCalls = 0;
  let iteratorCalls = 0;
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, Symbol.iterator);
  Object.defineProperty(Object.prototype, Symbol.iterator, {
    configurable: true,
    get() {
      getterCalls += 1;
      return function* inheritedIterator() {
        iteratorCalls += 1;
        yield 'ambient';
      };
    },
  });

  const engine = createEngine();
  try {
    assert.equal(
      engine.render('${{ values | dump }}', { values: [1, 2] }),
      '[1,2]',
    );
    assert.equal(getterCalls, 0);
    assert.equal(iteratorCalls, 0);
  } finally {
    if (previous) {
      Object.defineProperty(Object.prototype, Symbol.iterator, previous);
    } else {
      delete (Object.prototype as Record<PropertyKey, unknown>)[Symbol.iterator];
    }
  }
  assert.equal(engine.render('clean'), 'clean');
});

test('reserves prototype gadget names across values, syntax, and scopes', () => {
  const prepared = createEngine().prepareContext();
  for (const name of ['constructor', 'prototype', '__proto__']) {
    const context = Object.create(null) as Record<string, string>;
    context[name] = 'blocked';
    assert.throws(() => copyRuntimeContext(context), new RegExp(`key ${name} is reserved`));

    const scope = new RuntimeScope();
    assert.throws(() => scope.set(name, 'blocked'), /is reserved/);
    assert.equal(scope.get(name), undefined);
    assert.throws(() => prepared.withPath(['steps', name], 'blocked'), /is reserved/);
  }

  const engine = createEngine();
  for (const source of [
    '${{ constructor }}',
    '${{ value.constructor }}',
    '${{ value["prototype"] }}',
    '{% set __proto__ = 1 %}',
    '${{ {"constructor": 1} }}',
  ]) {
    assert.throws(() => engine.render(source), /reserved/);
  }
});

test('prepared context updates copy data without invoking accessors', () => {
  let getterCalls = 0;
  const withGetter = Object.defineProperty({}, 'secret', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'leaked';
    },
  });
  const prepared = createEngine().prepareContext({ steps: {} });
  assert.throws(
    () => prepared.withPath(['steps', 'unsafe'], withGetter as never),
    /cannot contain accessors/,
  );
  assert.equal(getterCalls, 0);

  const original = copyRuntimeContext({
    parameters: { stable: true },
    steps: { first: { output: 1 } },
  });
  const updated = withRuntimeContextPath(
    original,
    ['steps', 'second'],
    copyRuntimeValue({ output: 2 }),
  );
  assert.equal(updated.get('parameters'), original.get('parameters'));
  assert.notEqual(updated.get('steps'), original.get('steps'));

  const withUndefined = copyRuntimeContext({
    root: undefined as never,
    nested: { child: undefined as never },
    record: {},
  });
  for (const path of [
    ['root', 'leaf'],
    ['nested', 'child', 'leaf'],
  ]) {
    assert.throws(
      () => withRuntimeContextPath(withUndefined, path, copyRuntimeValue(1)),
      /is not a record/,
      path.join('.'),
    );
  }
  assert.equal(withUndefined.has('root'), true);
  assert.equal(withUndefined.get('root'), undefined);

  const withCreatedSegment = withRuntimeContextPath(
    withUndefined,
    ['missing', 'leaf'],
    copyRuntimeValue('created'),
  );
  const missing = withCreatedSegment.get('missing');
  assert.ok(missing instanceof RuntimeRecord);
  assert.equal(missing.get('leaf'), 'created');

  const withTraversedRecord = withRuntimeContextPath(
    withUndefined,
    ['record', 'leaf'],
    copyRuntimeValue('record'),
  );
  const record = withTraversedRecord.get('record');
  assert.ok(record instanceof RuntimeRecord);
  assert.equal(record.get('leaf'), 'record');

  const withReplacedUndefined = withRuntimeContextPath(
    withUndefined,
    ['root'],
    copyRuntimeValue('replacement'),
  );
  assert.equal(withReplacedUndefined.get('root'), 'replacement');
  assert.equal(withUndefined.get('root'), undefined);
});

test('owns aliases and exposes only frozen null-prototype callback copies', () => {
  const shared = { value: '<trusted>' };
  const copied = copyRuntimeValue([shared, shared]);
  assert.ok(copied instanceof RuntimeArray);
  assert.equal(copied.at(0), copied.at(1));
  assert.ok(copied.at(0) instanceof RuntimeRecord);

  const publicValue = copyPublicValue(copied);
  assert.ok(Array.isArray(publicValue));
  assert.equal(publicValue[0], publicValue[1]);
  assert.equal(Object.getPrototypeOf(publicValue[0]), null);
  assert.ok(Object.isFrozen(publicValue));
  assert.ok(Object.isFrozen(publicValue[0]));

  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  assert.throws(() => copyRuntimeValue(cyclic as never), /Cyclic template values/);
});

test('scope lookup never falls through to host globals or polluted prototypes', () => {
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'polluted');
  Object.defineProperty(Object.prototype, 'polluted', {
    configurable: true,
    value: 'host',
  });
  try {
    const copied = copyRuntimeContext({ own: 'value' });
    assert.equal(copied.get('own'), 'value');
    assert.equal(copied.get('polluted'), undefined);

    const scope = new RuntimeScope();
    scope.set('value', 1);
    assert.equal(scope.get('process'), undefined);
    assert.equal(scope.get('globalThis'), undefined);
    assert.equal(scope.get('toString'), undefined);
    assert.equal(scope.get('constructor'), undefined);
  } finally {
    if (previous) {
      Object.defineProperty(Object.prototype, 'polluted', previous);
    } else {
      delete (Object.prototype as Record<string, unknown>).polluted;
    }
  }
});

test('dump does not invoke inherited host serialization hooks', () => {
  let getterCalls = 0;
  let hookCalls = 0;
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
  Object.defineProperty(Object.prototype, 'toJSON', {
    configurable: true,
    get() {
      getterCalls += 1;
      return function inheritedToJson() {
        hookCalls += 1;
        return 'ambient';
      };
    },
  });

  const engine = createEngine();
  try {
    assert.equal(
      engine.render('${{ [1, {"safe": 2}] | dump }}'),
      '[1,{"safe":2}]',
    );
    assert.equal(
      engine.render('${{ {"toJSON": "data", "toString": "text"} | dump }}'),
      '{"toJSON":"data","toString":"text"}',
    );
    assert.equal(engine.render('${{ r/secret/gimy | dump }}'), '{}');
    assert.equal(
      engine.render('${{ [r/secret/, {value:r/nested/}] | dump }}'),
      '[{},{"value":{}}]',
    );
    assert.equal(getterCalls, 0);
    assert.equal(hookCalls, 0);
  } finally {
    if (previous) {
      Object.defineProperty(Object.prototype, 'toJSON', previous);
    } else {
      delete (Object.prototype as Record<string, unknown>).toJSON;
    }
  }
  assert.equal(engine.render('clean'), 'clean');

  let setterCalls = 0;
  let dumpResult: ReturnType<typeof applyBuiltinFilter> = undefined;
  let dumpFailure: unknown = undefined;
  const previousIndex = Object.getOwnPropertyDescriptor(Object.prototype, '0');
  Object.defineProperty(Object.prototype, '0', {
    configurable: true,
    set() {
      setterCalls += 1;
    },
  });
  try {
    dumpResult = applyBuiltinFilter(
      'dump',
      new RuntimeArray([1]),
      [],
      new Map(),
      () => {},
    );
  } catch (error) {
    dumpFailure = error;
  } finally {
    if (previousIndex) {
      Object.defineProperty(Object.prototype, '0', previousIndex);
    } else {
      delete (Object.prototype as Record<string, unknown>)['0'];
    }
  }
  assert.equal(dumpFailure, undefined);
  assert.equal(dumpResult, '[1]');
  assert.equal(setterCalls, 0);

  let regexHookCalls = 0;
  const runtimeRegexToJson = Object.getOwnPropertyDescriptor(
    RuntimeRegex.prototype,
    'toJSON',
  );
  const nativeRegexToJson = Object.getOwnPropertyDescriptor(RegExp.prototype, 'toJSON');
  for (const prototype of [RuntimeRegex.prototype, RegExp.prototype]) {
    Object.defineProperty(prototype, 'toJSON', {
      configurable: true,
      get() {
        regexHookCalls += 1;
        throw new Error('Regex serialization hooks must not run');
      },
    });
  }
  try {
    assert.equal(
      applyBuiltinFilter(
        'dump',
        new RuntimeRegex('secret', 'gimy'),
        [],
        new Map(),
        () => {},
      ),
      '{}',
    );
    assert.equal(regexHookCalls, 0);
  } finally {
    for (const [prototype, descriptor] of [
      [RuntimeRegex.prototype, runtimeRegexToJson],
      [RegExp.prototype, nativeRegexToJson],
    ] as const) {
      if (descriptor) {
        Object.defineProperty(prototype, 'toJSON', descriptor);
      } else {
        Reflect.deleteProperty(prototype, 'toJSON');
      }
    }
  }
});

test('regex coercion does not invoke internal or host RegExp string hooks', () => {
  let hookCalls = 0;
  const runtimeDescriptor = Object.getOwnPropertyDescriptor(
    RuntimeRegex.prototype,
    'toString',
  );
  const nativeDescriptor = Object.getOwnPropertyDescriptor(RegExp.prototype, 'toString');
  for (const prototype of [RuntimeRegex.prototype, RegExp.prototype]) {
    Object.defineProperty(prototype, 'toString', {
      configurable: true,
      get() {
        hookCalls += 1;
        throw new Error('Regex string hooks must not run');
      },
    });
  }

  try {
    const engine = createEngine({
      globals: {
        observe(value) {
          return value;
        },
      },
    });
    assert.equal(
      engine.render('${{ r// }}|${{ r/x/yimg + "" }}|${{ observe(r/a\nb/) }}'),
      '/(?:)/|/x/gimy|/a\\nb/',
    );
    assert.equal(hookCalls, 0);
  } finally {
    for (const [prototype, descriptor] of [
      [RuntimeRegex.prototype, runtimeDescriptor],
      [RegExp.prototype, nativeDescriptor],
    ] as const) {
      if (descriptor) {
        Object.defineProperty(prototype, 'toString', descriptor);
      } else {
        Reflect.deleteProperty(prototype, 'toString');
      }
    }
  }
});

test('templates cannot reach ambient authority or invoke looked-up values', () => {
  const engine = createEngine();
  for (const source of [
    '${{ globalThis }}',
    '${{ process }}',
    '${{ require }}',
    '${{ module }}',
    '${{ value["con" + "structor"] }}',
    '${{ value["proto" + "type"] }}',
    '${{ value["__pro" + "to__"] }}',
  ]) {
    assert.equal(engine.render(source, { value: { safe: 'data' } }), '', source);
  }

  for (const source of [
    '${{ value.toString() }}',
    '${{ value["to" + "String"]() }}',
    '${{ process.mainModule.require("node:fs") }}',
    '${{ value.constructor.constructor("return process")() }}',
  ]) {
    assert.throws(() => engine.render(source, { value: { toString: 'data' } }), source);
  }
});

test('call targets resolve through closed runtime values before capability dispatch', () => {
  let calls = 0;
  const engine = createEngine({
    globals: {
      dangerous() {
        calls += 1;
        return 'host callback';
      },
    },
  });

  assert.throws(() => engine.render('${{ dangerous() }}', { dangerous: 'not callable' }));
  assert.equal(calls, 0);
  assert.throws(() => engine.render([
    '{% set dangerous = "not callable" %}',
    '${{ dangerous() }}',
  ].join('')));
  assert.equal(calls, 0);
  assert.equal(engine.render('${{ dangerous() }}'), 'host callback');
  assert.equal(calls, 1);
  assert.equal(
    engine.render('{% set alias = dangerous %}${{ alias() }}'),
    'host callback',
  );
  assert.equal(calls, 2);
  assert.equal(
    engine.render('{% set aliases = [dangerous] %}${{ aliases[0]() }}'),
    'host callback',
  );
  assert.equal(calls, 3);
  assert.throws(() => engine.render('${{ values[name]() }}', {
    values: { dangerous: 'dangerous' },
    name: 'dangerous',
  }));
  assert.equal(calls, 3);

  for (const name of ['ops.exec', 'cycle.next']) {
    const dottedGlobals = Object.create(null) as Record<string, () => string>;
    dottedGlobals[name] = () => {
      calls += 1;
      return 'host callback';
    };
    assert.throws(
      () => createEngine({ globals: dottedGlobals }),
      /valid template identifier/,
    );
  }
  const builtinEngine = createEngine();
  assert.equal(
    builtinEngine.render('{% set cycle = cycler("internal") %}${{ cycle.next() }}'),
    'internal',
  );
  assert.throws(() => builtinEngine.render('${{ range(0, 1) }}', {
    range: 'not callable',
  }));
  assert.equal(calls, 3);
  assert.equal(builtinEngine.render('clean'), 'clean');

  let oracleCalls = 0;
  const oracle = new nunjucks.Environment(undefined, { autoescape: false });
  oracle.addGlobal('dangerous', () => {
    oracleCalls += 1;
    return 'host callback';
  });
  assert.throws(() => oracle.renderString(
    '{% set dangerous = "not callable" %}{{ dangerous() }}',
    {},
  ));
  oracle.addGlobal('ops.exec', () => {
    oracleCalls += 1;
    return 'host callback';
  });
  assert.throws(() => oracle.renderString('{{ ops.exec("ignored") }}', {}));
  assert.throws(() => oracle.renderString('{{ ops.exec("ignored") }}', {
    ops: { exec: 'not callable' },
  }));
  assert.equal(oracleCalls, 0);
  assert.equal(engine.render('clean'), 'clean');
});

test('macro defaults execute only when an argument is genuinely absent', () => {
  let defaultCalls = 0;
  let failDefault = false;
  const engine = createEngine({
    globals: {
      privilegedDefault() {
        defaultCalls += 1;
        if (failDefault) {
          throw new Error('default failed');
        }
        return 'DEFAULT';
      },
    },
  });
  const source = [
    '{% macro render(value=privilegedDefault()) %}[${{ value }}]{% endmacro %}',
    '${{ render(null) }}|${{ render(value=null) }}|',
    '${{ render(missing) }}|${{ render(value=missing) }}|',
    '${{ render(false) }}|${{ render(value=false) }}|',
    '${{ render(0) }}|${{ render(value=0) }}|',
    '${{ render("") }}|${{ render(value="") }}|',
    '${{ render() }}',
  ].join('');
  const expected = '[]|[]|[]|[]|[false]|[false]|[0]|[0]|[]|[]|[DEFAULT]';

  assert.equal(engine.render(source), expected);
  assert.equal(defaultCalls, 1);

  let oracleCalls = 0;
  const oracle = new nunjucks.Environment(undefined, { autoescape: false });
  oracle.addGlobal('privilegedDefault', () => {
    oracleCalls += 1;
    return 'DEFAULT';
  });
  assert.equal(oracle.renderString(source.replaceAll('${{', '{{'), {}), expected);
  assert.equal(oracleCalls, 1);

  failDefault = true;
  assert.throws(() => engine.render([
    '{% macro render(value=privilegedDefault()) %}${{ value }}{% endmacro %}',
    '${{ render() }}',
  ].join('')));
  assert.equal(defaultCalls, 2);
  assert.equal(engine.render('clean'), 'clean');
});

test('macro binding uses formal positions and admits only the special caller keyword', () => {
  let privilegedCalls = 0;
  let oraclePrivilegedCalls = 0;
  let laterCalls = 0;
  const defaultCalls: string[] = [];
  const oracleDefaultCalls: string[] = [];
  const engine = createEngine({
    globals: {
      privileged() {
        privilegedCalls += 1;
        return 'PRIVILEGED';
      },
      defaultValue(name) {
        if (typeof name !== 'string') {
          throw new TypeError('default name must be a string');
        }
        defaultCalls.push(name);
        return name;
      },
      later() {
        laterCalls += 1;
        return 'not reached';
      },
    },
  });
  const oracle = new nunjucks.Environment(undefined, { autoescape: false });
  oracle.addGlobal('privileged', () => {
    oraclePrivilegedCalls += 1;
    return 'PRIVILEGED';
  });
  oracle.addGlobal('defaultValue', (name: string) => {
    oracleDefaultCalls.push(name);
    return name;
  });

  const parityCases = [
    {
      source: [
        '{% macro f(a, b="B", c="C") %}[${{ a }}|${{ b }}|${{ c }}]{% endmacro %}',
        '${{ f("P", a="K") }}|${{ f("A", "P", b="K") }}|${{ f("A", "B", a="K") }}',
      ].join(''),
      expected: '[P|B|C]|[A|P|C]|[A|B|C]',
    },
    {
      source: [
        '{% macro wrapper(value) %}[${{ extra is defined }}]{% endmacro %}',
        '${{ wrapper("x", extra="hidden") }}',
      ].join(''),
      expected: '[false]',
    },
    {
      source: [
        '{% macro wrapper(value) %}[${{ caller() }}]{% endmacro %}',
        '{% call wrapper("x") %}BODY{% endcall %}',
      ].join(''),
      expected: '[BODY]',
    },
  ];
  for (const { source, expected } of parityCases) {
    assert.equal(engine.render(source), expected);
    assert.equal(oracle.renderString(source.replaceAll('${{', '{{'), {}), expected);
  }

  const defaultSource = [
    '{% macro f(a=defaultValue("a"), b=defaultValue("b"), c=defaultValue("c")) %}',
    '[${{ a }}|${{ b }}|${{ c }}]',
    '{% endmacro %}',
    '${{ f("P", a="K") }}',
  ].join('');
  assert.equal(engine.render(defaultSource), '[P|b|c]');
  assert.deepEqual(defaultCalls, ['b', 'c']);
  assert.equal(
    oracle.renderString(defaultSource.replaceAll('${{', '{{'), {}),
    '[P|b|c]',
  );
  assert.deepEqual(oracleDefaultCalls, ['b', 'c']);

  const explicitCallerSource = [
    '{% macro wrapper(value) %}[${{ caller() }}]{% endmacro %}',
    '${{ wrapper("x", caller=privileged) }}',
  ].join('');
  assert.equal(engine.render(explicitCallerSource), '[PRIVILEGED]');
  assert.equal(privilegedCalls, 1);
  assert.equal(
    oracle.renderString(explicitCallerSource.replaceAll('${{', '{{'), {}),
    '[PRIVILEGED]',
  );
  assert.equal(oraclePrivilegedCalls, 1);

  const injectedCallableSource = [
    '{% macro wrapper(value) %}[${{ dispatch() }}]{% endmacro %}',
    '${{ wrapper("x", dispatch=privileged) }}',
    '${{ later() }}',
  ].join('');
  assert.throws(
    () => engine.render(injectedCallableSource),
    error => error instanceof NunjitsuRenderError,
  );
  assert.equal(privilegedCalls, 1);
  assert.equal(laterCalls, 0);
  assert.throws(() => oracle.renderString(
    injectedCallableSource.replaceAll('${{', '{{'),
    {},
  ));
  assert.equal(oraclePrivilegedCalls, 1);
  assert.equal(engine.render('clean'), 'clean');
});

test('rejects invalid macro and caller declarations before capability dispatch', () => {
  const engineCalls: string[] = [];
  const oracleCalls: string[] = [];
  const capabilities = {
    capability() {
      engineCalls.push('capability');
      return 'value';
    },
    wrapperCall() {
      engineCalls.push('wrapper');
      return '';
    },
    bodyCall() {
      engineCalls.push('body');
      return '';
    },
    privileged() {
      engineCalls.push('privileged');
      return '';
    },
    failingWrapper() {
      engineCalls.push('failing-wrapper');
      throw new Error('wrapper failed');
    },
  };
  const engine = createEngine({ globals: capabilities });
  const oracle = new nunjucks.Environment(undefined, { autoescape: false });
  for (const name of Object.keys(capabilities)) {
    oracle.addGlobal(name, () => {
      oracleCalls.push(name);
      if (name === 'failingWrapper') {
        throw new Error('wrapper failed');
      }
      return name === 'capability' ? 'value' : '';
    });
  }
  const invalidFormals = [
    '1',
    'true',
    'null',
    '"name"',
    '[value]',
    'left + right',
    'capability()',
    'record.field',
  ];
  for (const formal of invalidFormals) {
    const macroSources = [
      `{% macro unused(${formal}) %}` + '${{ bodyCall() }}{% endmacro %}${{ privileged() }}',
      `{% macro invoked(${formal}) %}` + '${{ bodyCall() }}{% endmacro %}${{ invoked() }}${{ privileged() }}',
    ];
    for (const source of macroSources) {
      assert.throws(() => engine.render(source), NunjitsuRenderError);
      assert.throws(() => oracle.renderString(source.replaceAll('${{', '{{'), {}));
      assert.deepEqual(engineCalls, []);
      assert.deepEqual(oracleCalls, []);
      assert.equal(engine.render('clean'), 'clean');
    }

    const wrapperBodies = [
      '${{ wrapperCall() }}',
      '${{ wrapperCall() }}${{ caller() }}',
      '${{ failingWrapper() }}',
      'normal',
    ];
    for (const wrapperBody of wrapperBodies) {
      const source = [
        `{% macro wrapper() %}${wrapperBody}{% endmacro %}`,
        `{% call(${formal}) wrapper() %}` + '${{ bodyCall() }}{% endcall %}',
        '${{ privileged() }}',
      ].join('');
      assert.throws(() => engine.render(source), NunjitsuRenderError);
      assert.throws(() => oracle.renderString(source.replaceAll('${{', '{{'), {}));
      assert.deepEqual(engineCalls, []);
      assert.deepEqual(oracleCalls, []);
      assert.equal(engine.render('clean'), 'clean');
    }
  }
});

test('rejects malformed structural tags before any template capability executes', () => {
  const engineCalls: string[] = [];
  const oracleCalls: string[] = [];
  const names = ['before', 'inside', 'after', 'ignored'] as const;
  const engineGlobals = Object.fromEntries(names.map(name => [name, () => {
    engineCalls.push(name);
    return name;
  }]));
  const engine = createEngine({ globals: engineGlobals });
  const oracle = new nunjucks.Environment(undefined, { autoescape: false });
  for (const name of names) {
    oracle.addGlobal(name, () => {
      oracleCalls.push(name);
      return name;
    });
  }
  const malformedSources = [
    '${{ before() }}{% if false %}${{ inside() }}{% else junk %}${{ inside() }}{% endif %}${{ after() }}',
    '${{ before() }}{% if true %}${{ inside() }}{% endif junk %}${{ after() }}',
    '${{ before() }}{% for value in [] %}${{ inside() }}{% else junk %}${{ inside() }}{% endfor %}${{ after() }}',
    '${{ before() }}{% for value in [] %}${{ inside() }}{% endfor junk %}${{ after() }}',
    '${{ before() }}{% macro value() %}${{ inside() }}{% endmacro junk %}${{ after() }}',
    '{% macro wrapper() %}wrapper{% endmacro %}${{ before() }}{% call wrapper() %}${{ inside() }}{% endcall junk %}${{ after() }}',
    '${{ before() }}{% set value %}${{ inside() }}{% endset junk %}${{ after() }}',
    '${{ before() }}{% switch 1 %}{% case 2 %}${{ inside() }}{% default junk %}${{ inside() }}{% endswitch %}${{ after() }}',
    '${{ before() }}{% switch 1 %}{% case 1 %}${{ inside() }}{% endswitch junk %}${{ after() }}',
    '${{ before() }}{% block content %}${{ inside() }}{% endblock different %}${{ after() }}',
    '${{ before() }}{% block content %}${{ inside() }}{% endblock content junk %}${{ after() }}',
    '${{ before() }}{% block content %}${{ inside() }}{% endblock expression() %}${{ after() }}',
    '${{ before() }}{% block content %}${{ inside() }}{% endblock "literal" %}${{ after() }}',
    '${{ before() }}{% raw junk %}${{ ignored() }}{% endraw %}${{ after() }}',
    '${{ before() }}{% verbatim junk %}${{ ignored() }}{% endverbatim %}${{ after() }}',
    '${{ before() }}{% raw %}X{%- endraw %}${{ after() }}',
    '${{ before() }}{% raw %}X{% endraw -%}${{ after() }}',
  ];
  for (const source of malformedSources) {
    assert.throws(() => engine.render(source), NunjitsuRenderError);
    assert.throws(() => oracle.renderString(source.replaceAll('${{', '{{'), {}));
    assert.deepEqual(engineCalls, []);
    assert.deepEqual(oracleCalls, []);
    assert.equal(engine.render('clean'), 'clean');
  }

  for (const cookiecutterCompat of [false, true]) {
    const invalidSwitchCalls: string[] = [];
    const invalidSwitchEngine = createEngine({
      cookiecutterCompat,
      globals: {
        before() {
          invalidSwitchCalls.push('before');
          return '';
        },
        after() {
          invalidSwitchCalls.push('after');
          return '';
        },
      },
    });
    const invalidSwitchOracleCalls: string[] = [];
    const invalidSwitchOracle = new nunjucks.Environment(undefined, {
      autoescape: false,
    });
    for (const name of ['before', 'after']) {
      invalidSwitchOracle.addGlobal(name, () => {
        invalidSwitchOracleCalls.push(name);
        return '';
      });
    }
    for (const source of [
      '{{ before() }}{% switch 1 %}{% endswitch %}{{ after() }}',
      '{{ before() }}{% switch 1 %}{# no arms #}{% endswitch %}{{ after() }}',
      '{{ before() }}{% if false %}{% switch 1 %}{% endswitch %}{% endif %}{{ after() }}',
    ]) {
      const engineSource = cookiecutterCompat
        ? source
        : source.replaceAll('{{', '${{');
      assert.throws(
        () => invalidSwitchEngine.render(engineSource),
        NunjitsuRenderError,
        source,
      );
      assert.throws(() => invalidSwitchOracle.renderString(source, {}), source);
      assert.deepEqual(invalidSwitchCalls, [], source);
      assert.deepEqual(invalidSwitchOracleCalls, [], source);
      assert.equal(invalidSwitchEngine.render('clean'), 'clean');
    }
  }

  for (const cookiecutterCompat of [false, true]) {
    const missingCloserCalls: string[] = [];
    const missingCloserEngine = createEngine({
      cookiecutterCompat,
      globals: {
        before() {
          missingCloserCalls.push('before');
          return '';
        },
        after() {
          missingCloserCalls.push('after');
          return '';
        },
      },
    });
    for (const source of [
      '{{ before() }}{% raw %}A{% raw %}B{% endraw %}{{ after() }}',
      '{{ before() }}{% verbatim %}A{% verbatim %}B{% endverbatim %}{{ after() }}',
      '{{ before() }}{% raw %}\nA{% raw %}B{% endraw %}{{ after() }}',
      '{{ before() }}{% verbatim -%}\r\nA{% verbatim %}B{% endverbatim %}{{ after() }}',
      '{{ before() }}{% raw %}A{%\nendraw\n%}{{ after() }}',
      '{{ before() }}{% verbatim %}A{%\r\nendverbatim\r\n%}{{ after() }}',
      '{{ before() }}{% raw %}A{%- raw %}B{% endraw %}{% endraw %}{{ after() }}',
      '{{ before() }}{% verbatim %}A{% verbatim -%}B{% endverbatim %}{% endverbatim %}{{ after() }}',
    ]) {
      const engineSource = cookiecutterCompat
        ? source
        : source.replaceAll('{{', '${{');
      assert.throws(() => missingCloserEngine.render(engineSource), NunjitsuRenderError);
      assert.deepEqual(missingCloserCalls, []);
      assert.equal(missingCloserEngine.render('clean'), 'clean');
    }
    const limitedSource = cookiecutterCompat
      ? '{{ before() }}{% raw %}\nX'
      : '${{ before() }}{% raw %}\nX';
    assert.throws(
      () => missingCloserEngine.render(
        limitedSource,
        {},
        { limits: { sourceCodeUnits: 1 } },
      ),
      NunjitsuLimitError,
    );
    assert.deepEqual(missingCloserCalls, []);
    assert.equal(missingCloserEngine.render('clean'), 'clean');
  }

  for (const cookiecutterCompat of [false, true]) {
    const conditionalCalls: string[] = [];
    const conditionalEngine = createEngine({
      cookiecutterCompat,
      globals: {
        before() {
          conditionalCalls.push('before');
          return '';
        },
        inside() {
          conditionalCalls.push('inside');
          return '';
        },
        after() {
          conditionalCalls.push('after');
          return '';
        },
      },
    });
    const conditionalOracleCalls: string[] = [];
    const conditionalOracle = new nunjucks.Environment(undefined, { autoescape: false });
    for (const name of ['before', 'inside', 'after']) {
      conditionalOracle.addGlobal(name, () => {
        conditionalOracleCalls.push(name);
        return '';
      });
    }
    for (const source of [
      '{{ before() }}{% if false %}{{ inside() }}{% elseif %}{{ inside() }}{% endif %}{{ after() }}',
      '{{ before() }}{% if false %}{{ inside() }}{% elseif true junk %}{{ inside() }}{% endif %}{{ after() }}',
      '{{ before() }}{% if false %}{{ inside() }}{% else if true %}{{ inside() }}{% endif %}{{ after() }}',
    ]) {
      const engineSource = cookiecutterCompat
        ? source
        : source.replaceAll('{{', '${{');
      assert.throws(() => conditionalEngine.render(engineSource), NunjitsuRenderError);
      assert.throws(() => conditionalOracle.renderString(source, {}));
      assert.deepEqual(conditionalCalls, []);
      assert.deepEqual(conditionalOracleCalls, []);
      assert.equal(conditionalEngine.render('clean'), 'clean');
    }
  }

  const validBlockSources = [
    '{% block content %}body{% endblock %}',
    '{% block content %}body{% endblock content %}',
  ];
  for (const source of validBlockSources) {
    assert.equal(engine.render(source), oracle.renderString(source, {}));
  }

  const rawEngine = createEngine({
    cookiecutterCompat: true,
    globals: engineGlobals,
  });
  for (const source of [
    '{% raw %}{{ ignored() }}{% endraw %}{{ after() }}',
    '{% verbatim %}{{ ignored() }}{% endverbatim %}{{ after() }}',
  ]) {
    engineCalls.length = 0;
    oracleCalls.length = 0;
    assert.equal(rawEngine.render(source), oracle.renderString(source, {}));
    assert.deepEqual(engineCalls, ['after']);
    assert.deepEqual(oracleCalls, engineCalls);
  }
});

test('rejects unterminated and unexpected comment closers before capability dispatch', () => {
  const malformedComments = [
    '${{ before() }}{# "',
    "${{ before() }}{# '",
    '${{ before() }}{# \\',
    '${{ before() }}{# outer {# nested',
    '${{ before() }}#}',
    '${{ before() }}A-#}B',
    '${{ before() }}A{# valid #}#}',
    '${{ before() }}{% if true %}body{% endif %}#}',
  ];
  const optionCases = [
    { trimBlocks: false, lstripBlocks: false },
    { trimBlocks: true, lstripBlocks: false },
    { trimBlocks: false, lstripBlocks: true },
    { trimBlocks: true, lstripBlocks: true },
  ];

  for (const cookiecutterCompat of [false, true]) {
    for (const options of optionCases) {
      const engineEvents: string[] = [];
      const oracleEvents: string[] = [];
      const engine = createEngine({
        cookiecutterCompat,
        ...options,
        globals: {
          before() {
            engineEvents.push('before');
            return '';
          },
        },
      });
      const oracle = new nunjucks.Environment(undefined, {
        autoescape: false,
        ...options,
      });
      oracle.addGlobal('before', () => {
        oracleEvents.push('before');
        return '';
      });

      for (const source of malformedComments) {
        const engineSource = cookiecutterCompat
          ? source.replaceAll('${{', '{{')
          : source;
        let caught: NunjitsuRenderError | undefined;
        assert.throws(
          () => engine.render(engineSource),
          error => {
            if (!(error instanceof NunjitsuRenderError)) {
              return false;
            }
            caught = error;
            return true;
          },
          source,
        );
        assert.equal(caught?.phase, 'parse', source);
        assert.equal(caught?.code, 'syntax_error', source);
        assert.equal(caught?.cause, undefined, source);
        assert.throws(
          () => oracle.renderString(source.replaceAll('${{', '{{'), {}),
          source,
        );
        assert.deepEqual(engineEvents, [], source);
        assert.deepEqual(oracleEvents, [], source);
        assert.equal(engine.render('clean'), 'clean', source);
      }

      engineEvents.length = 0;
      assert.throws(
        () => engine.render(
          cookiecutterCompat ? '{{ before() }}#}' : '${{ before() }}#}',
          {},
          { limits: { sourceCodeUnits: 1 } },
        ),
        NunjitsuLimitError,
      );
      assert.deepEqual(engineEvents, []);
      assert.equal(engine.render('clean'), 'clean');
    }
  }
});

test('rejects macro declarations inside captured output before execution', () => {
  for (const cookiecutterCompat of [false, true]) {
    const events: string[] = [];
    const engine = createEngine({
      cookiecutterCompat,
      globals: {
        before() {
          events.push('before');
          return '';
        },
        after() {
          events.push('after');
          return '';
        },
      },
    });
    const sources = [
      '${{ before() }}{% set captured %}{% macro value() %}M{% endmacro %}${{ value() }}{% endset %}${{ after() }}',
      '${{ before() }}{% filter upper %}{% macro value() %}M{% endmacro %}${{ value() }}{% endfilter %}${{ after() }}',
      '${{ before() }}{% set captured %}{% if true %}{% macro value() %}M{% endmacro %}{% endif %}{% endset %}${{ after() }}',
      '${{ before() }}{% filter upper %}{% block nested %}{% macro value() %}M{% endmacro %}{% endblock %}{% endfilter %}${{ after() }}',
    ];
    for (const source of sources) {
      const engineSource = cookiecutterCompat
        ? source.replaceAll('${{', '{{')
        : source;
      assert.throws(
        () => engine.render(engineSource),
        error => error instanceof NunjitsuRenderError && error.phase === 'parse',
        source,
      );
      assert.deepEqual(events, [], source);
      assert.equal(engine.render('clean'), 'clean');
    }
  }
});

test('rejects Nunjucks-invalid repeated unary signs before capability dispatch', () => {
  const invalidSources = [
    '${{ before() }}${{ - -mark() }}${{ later() }}',
    '${{ before() }}${{ ++mark() }}${{ later() }}',
    '${{ before() }}${{ - + +mark() }}${{ later() }}',
    '${{ before() }}${{ + - -mark() }}${{ later() }}',
    '${{ before() }}${{ - - + -mark() }}${{ later() }}',
    '{% if false %}${{ + +mark() }}{% endif %}${{ later() }}',
    '{% macro f(value=- -mark()) %}${{ value }}{% endmacro %}${{ later() }}',
    '${{ consume(+ +mark()) }}${{ later() }}',
    '${{ "x" | identity(- -mark()) }}${{ later() }}',
    '${{ [- -mark()] | first }}${{ later() }}',
    '${{ {value: + +mark()} | dump }}${{ later() }}',
    '${{ not - -mark() }}${{ later() }}',
    '${{ 1 * + +mark() }}${{ later() }}',
  ];
  for (const cookiecutterCompat of [false, true]) {
    const engineCalls: string[] = [];
    const oracleCalls: string[] = [];
    const engine = createEngine({
      cookiecutterCompat,
      filters: {
        identity(input) {
          engineCalls.push('identity');
          return input;
        },
      },
      globals: {
        before() {
          engineCalls.push('before');
          return 2;
        },
        consume(value) {
          engineCalls.push('consume');
          return value;
        },
        later() {
          engineCalls.push('later');
          return 2;
        },
        mark() {
          engineCalls.push('mark');
          return 2;
        },
      },
    });
    const oracle = new nunjucks.Environment(undefined, { autoescape: false });
    oracle.addFilter('identity', (input: unknown) => {
      oracleCalls.push('identity');
      return input;
    });
    for (const name of ['before', 'consume', 'later', 'mark']) {
      oracle.addGlobal(name, (value?: unknown) => {
        oracleCalls.push(name);
        return value ?? 2;
      });
    }
    for (const originalSource of invalidSources) {
      engineCalls.length = 0;
      oracleCalls.length = 0;
      const engineSource = cookiecutterCompat
        ? originalSource.replaceAll('${{', '{{')
        : originalSource;
      const oracleSource = originalSource.replaceAll('${{', '{{');
      let caught: NunjitsuRenderError | undefined;
      assert.throws(
        () => engine.render(engineSource),
        error => {
          if (!(error instanceof NunjitsuRenderError)) {
            return false;
          }
          caught = error;
          return true;
        },
        engineSource,
      );
      assert.throws(() => oracle.renderString(oracleSource, {}), oracleSource);
      assert.equal(caught?.phase, 'parse', engineSource);
      assert.equal(caught?.code, 'syntax_error', engineSource);
      assert.equal(caught?.cause, undefined, engineSource);
      assert.deepEqual(engineCalls, [], engineSource);
      assert.deepEqual(oracleCalls, [], oracleSource);
      assert.equal(engine.render('clean'), 'clean', engineSource);
    }

    engineCalls.length = 0;
    oracleCalls.length = 0;
    const validSource = [
      '${{ - +mark() }}|',
      '${{ + -mark() }}|',
      '${{ -(-mark()) }}|',
      '${{ +(+mark()) }}|',
      '${{ not not value }}',
    ].join('');
    const engineSource = cookiecutterCompat
      ? validSource.replaceAll('${{', '{{')
      : validSource;
    const oracleSource = validSource.replaceAll('${{', '{{');
    assert.equal(
      engine.render(engineSource, { value: true }),
      oracle.renderString(oracleSource, { value: true }),
    );
    assert.deepEqual(engineCalls, ['mark', 'mark', 'mark', 'mark']);
    assert.deepEqual(oracleCalls, engineCalls);
  }
});

test('restricts regex literals before capability dispatch', () => {
  const invalidSources = [
    '${{ before() }}${{ r/x/s }}${{ later() }}',
    '${{ before() }}${{ r/x/u }}${{ later() }}',
    '${{ before() }}${{ r/x/d }}${{ later() }}',
    '${{ before() }}${{ r/x/v }}${{ later() }}',
    '{% if "a\\nb" | replace(r/./gs, "x") == "xxx" %}${{ mark() }}{% endif %}',
    '{% if "😀" | replace(r/./gu, "x") == "x" %}${{ mark() }}{% endif %}',
    '{% if false %}${{ r/[a&&b]/v }}{% endif %}${{ later() }}',
    '{% macro f(value=r/x/s) %}${{ value }}{% endmacro %}${{ later() }}',
    '${{ consume(r/x/u) }}${{ later() }}',
    '${{ "x" | identity(r/x/d) }}${{ later() }}',
    '${{ [r/x/v] | first }}${{ later() }}',
    '${{ {value: r/x/a} | dump }}${{ later() }}',
    '${{ r/x/G }}${{ later() }}',
    '${{ r/x/gg }}${{ later() }}',
    '${{ r/x/uv }}${{ later() }}',
    '${{ before() }}${{ r/2 }}${{ later() }}',
    '${{ r/' + '\\'.repeat(2) + '/ }}${{ later() }}',
  ];

  for (const cookiecutterCompat of [false, true]) {
    const engineCalls: string[] = [];
    const oracleCalls: string[] = [];
    const engine = createEngine({
      cookiecutterCompat,
      filters: {
        identity(input) {
          engineCalls.push('identity');
          return input;
        },
      },
      globals: {
        before() {
          engineCalls.push('before');
          return '';
        },
        consume(value) {
          engineCalls.push('consume');
          return value;
        },
        later() {
          engineCalls.push('later');
          return '';
        },
        mark() {
          engineCalls.push('mark');
          return '';
        },
      },
    });
    const oracle = new nunjucks.Environment(undefined, { autoescape: false });
    oracle.addFilter('identity', (input: unknown) => {
      oracleCalls.push('identity');
      return input;
    });
    for (const name of ['before', 'consume', 'later', 'mark']) {
      oracle.addGlobal(name, (value?: unknown) => {
        oracleCalls.push(name);
        return value ?? '';
      });
    }

    for (const originalSource of invalidSources) {
      engineCalls.length = 0;
      oracleCalls.length = 0;
      const engineSource = cookiecutterCompat
        ? originalSource.replaceAll('${{', '{{')
        : originalSource;
      const oracleSource = originalSource.replaceAll('${{', '{{');
      let caught: NunjitsuRenderError | undefined;
      assert.throws(
        () => engine.render(engineSource),
        error => {
          if (!(error instanceof NunjitsuRenderError)) {
            return false;
          }
          caught = error;
          return true;
        },
        engineSource,
      );
      assert.throws(() => oracle.renderString(oracleSource, {}), oracleSource);
      assert.equal(caught?.phase, 'parse', engineSource);
      assert.equal(caught?.code, 'syntax_error', engineSource);
      assert.equal(caught?.cause, undefined, engineSource);
      assert.deepEqual(engineCalls, [], engineSource);
      assert.deepEqual(oracleCalls, [], oracleSource);
      assert.equal(engine.render('clean'), 'clean', engineSource);
    }

    const validSources = [
      '${{ r/x/ }}|${{ r/x/g }}|${{ r/x/i }}|${{ r/x/m }}|${{ r/x/y }}|${{ r/x/gimy }}',
      '${{ "aba" | replace(r/a/g, "x") }}',
      '${{ "A" | replace(r/a/i, "x") }}',
      '${{ "a\\nb" | replace(r/^b/m, "x") }}',
      '${{ "ab" | replace(r/a/y, "x") }}',
      '${{ r/' + '\\/' + '/ }}|${{ r/' + 'a\\/b' + '/ }}|${{ r/' +
        'a' + '\\'.repeat(3) + '/b' + '/ }}',
    ];
    for (const originalSource of validSources) {
      const engineSource = cookiecutterCompat
        ? originalSource.replaceAll('${{', '{{')
        : originalSource;
      const oracleSource = originalSource.replaceAll('${{', '{{');
      const expected = oracle.renderString(oracleSource, {});
      assert.equal(engine.render(engineSource), expected, engineSource);
      assert.equal(RegExp.$1, '', engineSource);
      assert.equal(RegExp.input, '', engineSource);
    }

    const divisionContext = {
      bar: 12,
      order: 8,
      longerIdentifier: 18,
      obj: { bar: 10 },
      s: 2,
      g: 3,
      a: 4,
      gg: 6,
      values: [1, 2, 3, 4],
    };
    const divisionSources = [
      [
        '${{ bar/2 }}|${{ order/2 }}|${{ longerIdentifier/2 }}|',
        '${{ obj.bar/2 }}|${{ bar /2 }}|${{ bar//5 }}|',
        '${{ bar/2/3 }}|${{ bar/2/s }}|${{ bar/2/g }}|',
        '${{ bar/2/a }}|${{ bar/2/gg }}|${{ bar/(1 + 1) }}',
      ].join(''),
      [
        '{% if bar/2 == 6 %}${{ mark() }}{% endif %}',
        '{% set value = order/2 %}${{ value }}',
      ].join(''),
      '{% macro render(value=bar/2) %}${{ value }}{% endmacro %}${{ render() }}',
      '${{ consume(bar/2) }}|${{ "x" | identity(bar/2) }}',
      '${{ [bar/2] | first }}|${{ {value: bar/2}.value }}',
      '{% for item in values | slice(bar/6) %}[${{ item | join(",") }}]{% endfor %}',
    ];
    for (const originalSource of divisionSources) {
      engineCalls.length = 0;
      oracleCalls.length = 0;
      const engineSource = cookiecutterCompat
        ? originalSource.replaceAll('${{', '{{')
        : originalSource;
      const oracleSource = originalSource.replaceAll('${{', '{{');
      assert.equal(
        engine.render(engineSource, divisionContext),
        oracle.renderString(oracleSource, divisionContext),
        engineSource,
      );
      assert.deepEqual(engineCalls, oracleCalls, engineSource);
    }
  }
});

test('rejects malformed call-block signature regexes before capability dispatch', () => {
  const malformedValues = [
    'r/[)/',
    'r/\\)/gg',
    '[r/[)/]',
    '{pattern:r/[)/}',
  ];
  for (const cookiecutterCompat of [false, true]) {
    const events: string[] = [];
    const oracleEvents: string[] = [];
    const engine = createEngine({
      cookiecutterCompat,
      globals: {
        before() {
          events.push('before');
          return '';
        },
        body() {
          events.push('body');
          return '';
        },
        after() {
          events.push('after');
          return '';
        },
      },
    });
    const oracle = new nunjucks.Environment(undefined, { autoescape: false });
    for (const name of ['before', 'body', 'after']) {
      oracle.addGlobal(name, () => {
        oracleEvents.push(name);
        return '';
      });
    }
    for (const value of malformedValues) {
      const source = [
        '${{ before() }}',
        '{% macro wrap() %}${{ caller() }}{% endmacro %}',
        '{% call(value=' + value + ') wrap() %}${{ body() }}{% endcall %}',
        '${{ after() }}',
      ].join('');
      const engineSource = cookiecutterCompat
        ? source.replaceAll('${{', '{{')
        : source;
      let caught: NunjitsuRenderError | undefined;
      assert.throws(
        () => engine.render(engineSource),
        error => {
          if (!(error instanceof NunjitsuRenderError)) {
            return false;
          }
          caught = error;
          return true;
        },
        value,
      );
      assert.equal(caught?.phase, 'parse', value);
      assert.equal(caught?.code, 'syntax_error', value);
      assert.equal(caught?.cause, undefined, value);
      assert.deepEqual(events, [], value);
      assert.throws(
        () => oracle.renderString(source.replaceAll('${{', '{{'), {}),
        value,
      );
      assert.deepEqual(oracleEvents, [], value);
      assert.equal(engine.render('clean'), 'clean', value);
    }
  }
});

test('matches Nunjucks string escapes before capability dispatch', () => {
  const stringSources = [
    String.raw`{{ "\n" | dump }}|{{ "\t" | dump }}|{{ "\r" | dump }}`,
    String.raw`{{ "\b" | dump }}|{{ "\f" | dump }}|{{ "\v" | dump }}`,
    String.raw`{{ "\x41" | dump }}|{{ "\x0a" | dump }}|{{ "\xZZ" | dump }}`,
    String.raw`{{ "\u0041" | dump }}|{{ "\u2028" | dump }}|{{ "\uD800" | dump }}`,
    String.raw`{{ "\uZZZZ" | dump }}|{{ "\u{1F600}" | dump }}`,
    String.raw`{{ "\q" | dump }}|{{ "\0" | dump }}|{{ "\\" | dump }}`,
    String.raw`{{ "\"" | dump }}|{{ '\'' | dump }}`,
    String.raw`{{ "\\x41" | dump }}|{{ "\\u0041" | dump }}`,
    ['{{ "raw', 'newline" | dump }}'].join('\n'),
    ['{{ "escaped\\', 'newline" | dump }}'].join('\n'),
  ];
  const semanticSources = [
    [
      String.raw`{% set assigned="\x41" %}`,
      String.raw`{% macro show(value="\u0041") %}{{ value }}{% endmacro %}`,
      String.raw`{{ assigned }}|{{ show() }}`,
    ].join(''),
    String.raw`{{ capture("\x41") }}|{{ "input" | observe("\u0041") }}`,
    String.raw`{{ ["\x41"] | dump }}|{{ {value: "\u0041"} | dump }}`,
    [
      String.raw`{% if "\x41" == "A" %}{{ privileged() }}{% endif %}`,
      String.raw`{% if "\u0041" == "A" %}{{ privileged() }}{% endif %}`,
      String.raw`{% if "\b" == "b" %}ok{% else %}{{ privileged() }}{% endif %}`,
    ].join(''),
    String.raw`{{ {"\u0063onstructor": 1} | dump }}|{{ record["\u0063onstructor"] }}`,
  ];

  for (const cookiecutterCompat of [false, true]) {
    const engineEvents: unknown[] = [];
    const oracleEvents: unknown[] = [];
    const engine = createEngine({
      cookiecutterCompat,
      filters: {
        observe(input, value) {
          engineEvents.push(['observe', value]);
          return input;
        },
      },
      globals: {
        capture(value) {
          engineEvents.push(['capture', value]);
          return value;
        },
        privileged() {
          engineEvents.push(['privileged']);
          return '';
        },
      },
    });
    const oracle = new nunjucks.Environment(undefined, { autoescape: false });
    oracle.addFilter('observe', (input: unknown, value: unknown) => {
      oracleEvents.push(['observe', value]);
      return input;
    });
    oracle.addGlobal('capture', (value: unknown) => {
      oracleEvents.push(['capture', value]);
      return value;
    });
    oracle.addGlobal('privileged', () => {
      oracleEvents.push(['privileged']);
      return '';
    });

    for (const source of [...stringSources, ...semanticSources]) {
      engineEvents.length = 0;
      oracleEvents.length = 0;
      const engineSource = cookiecutterCompat ? source : source.replaceAll('{{', '${{');
      const context = { record: { u0063onstructor: 2 } };
      assert.equal(
        engine.render(engineSource, context),
        oracle.renderString(source, context),
        source,
      );
      assert.deepEqual(engineEvents, oracleEvents, source);
    }

    const reservedSource = cookiecutterCompat
      ? '{{ {"constructor": 1} }}'
      : '${{ {"constructor": 1} }}';
    assert.throws(
      () => engine.render(reservedSource),
      error => error instanceof NunjitsuRenderError && error.phase === 'parse',
    );
    assert.equal(engine.render('clean'), 'clean');

    for (const source of [
      ['{{ "a', 'b" + broken( }}'].join('\n'),
      ['first line', '{{ "a', 'b" + broken( }}'].join('\n'),
      ['{{ "a\\', 'b" + broken( }}'].join('\n'),
    ]) {
      const engineSource = cookiecutterCompat ? source : source.replaceAll('{{', '${{');
      let caught: NunjitsuRenderError | undefined;
      assert.throws(
        () => engine.render(engineSource),
        error => {
          if (!(error instanceof NunjitsuRenderError)) {
            return false;
          }
          caught = error;
          return true;
        },
      );
      assert.throws(() => oracle.renderString(source, {}));
      assert.equal(caught?.line, source.startsWith('first line') ? 3 : 2, source);
      assert.equal(caught?.column, 14, source);
      assert.equal(engine.render('clean'), 'clean');
    }
  }
});

test('restricts numeric literals before capability dispatch', () => {
  const invalidForms = [
    '.5',
    '1e3',
    '1E3',
    '1e+3',
    '1e-3',
    '1.e3',
    '1.0e3',
    '0x10',
    '0Xff',
    '0b10',
    '0B10',
    '0o10',
    '0O10',
    '1_000',
    '123abc',
  ];
  const positionSources = [
    '{{ before() }}{{ .5 }}{{ later() }}',
    '{% if false %}{{ .5 }}{% endif %}{{ later() }}',
    '{% set value = 1e3 %}{{ later() }}',
    '{% macro render(value=0x10) %}{{ value }}{% endmacro %}{{ later() }}',
    '{{ consume(.5) }}{{ later() }}',
    '{{ "x" | observe(1e3) }}{{ later() }}',
    '{{ [.5, 1e3, 0x10] | dump }}{{ later() }}',
    '{{ {fraction: .5, exponent: 1e3, hex: 0x10} | dump }}{{ later() }}',
    '{{ values[.5] }}{{ later() }}',
    '{% for item in 1e3 %}{{ body() }}{% endfor %}{{ later() }}',
    '{% switch 0x10 %}{% case 16 %}{{ body() }}{% endswitch %}{{ later() }}',
  ];
  const branchSources = [
    '{% if 1e3 == 1000 %}{{ privileged() }}{% endif %}',
    '{% if 0x10 == 16 %}{{ privileged() }}{% endif %}',
    '{% if .5 == 0.5 %}{{ privileged() }}{% endif %}',
    '{% if 1e309 %}{{ privileged() }}{% endif %}',
    '{% if false %}{{ .5 }}{% endif %}{{ later() }}',
  ];

  for (const cookiecutterCompat of [false, true]) {
    const engineCalls: string[] = [];
    const oracleCalls: string[] = [];
    const engine = createEngine({
      cookiecutterCompat,
      filters: {
        observe(input) {
          engineCalls.push('observe');
          return input;
        },
      },
      globals: {
        before() {
          engineCalls.push('before');
          return '';
        },
        body() {
          engineCalls.push('body');
          return '';
        },
        consume(value) {
          engineCalls.push('consume');
          return value;
        },
        later() {
          engineCalls.push('later');
          return '';
        },
        privileged() {
          engineCalls.push('privileged');
          return '';
        },
      },
    });
    const oracle = new nunjucks.Environment(undefined, { autoescape: false });
    for (const name of ['before', 'body', 'consume', 'later', 'privileged']) {
      oracle.addGlobal(name, (value?: unknown) => {
        oracleCalls.push(name);
        return value ?? '';
      });
    }

    const assertRejected = (source: string): NunjitsuRenderError => {
      engineCalls.length = 0;
      const engineSource = cookiecutterCompat ? source : source.replaceAll('{{', '${{');
      let caught: NunjitsuRenderError | undefined;
      assert.throws(
        () => engine.render(engineSource, { values: [1, 2] }),
        error => {
          if (!(error instanceof NunjitsuRenderError)) {
            return false;
          }
          caught = error;
          return true;
        },
        source,
      );
      assert.equal(caught?.phase, 'parse', source);
      assert.equal(caught?.code, 'syntax_error', source);
      assert.deepEqual(engineCalls, [], source);
      assert.equal(engine.render('clean'), 'clean', source);
      return caught!;
    };

    for (const form of invalidForms) {
      assertRejected(`{{ before() }}{{ ${form} }}{{ later() }}`);
      assertRejected(`{{ before() }}{{ -${form} }}{{ later() }}`);
      assertRejected(`{{ before() }}{{ +${form} }}{{ later() }}`);
    }
    for (const source of positionSources) {
      assertRejected(source);
    }

    for (const source of branchSources) {
      assertRejected(source);
      oracleCalls.length = 0;
      try {
        oracle.renderString(source, {});
      } catch {
        // Leading-dot syntax is rejected by the pinned oracle.
      }
      assert.deepEqual(oracleCalls, [], source);
    }

    const validSource = [
      '{{ 0 }}|{{ 00 }}|{{ 01 }}|{{ 1. }}|{{ 1.0 }}|',
      '{{ 00.5 }}|{{ 01.50 }}|{{ +1.5 }}|{{ -1.5 }}',
    ].join('');
    const engineSource = cookiecutterCompat
      ? validSource
      : validSource.replaceAll('{{', '${{');
    assert.equal(engine.render(engineSource), oracle.renderString(validSource, {}));

    const largeDecimal = '9'.repeat(400);
    const overflowSource = `{{ ${largeDecimal} }}|{{ 1 / 0 }}`;
    assert.equal(
      engine.render(
        cookiecutterCompat ? overflowSource : overflowSource.replaceAll('{{', '${{'),
      ),
      oracle.renderString(overflowSource, {}),
    );

    assert.equal(
      oracle.renderString('{{ 1e3 }}|{{ 0x10 }}|{{ 123abc }}', {
        '1e3': 7,
        '0x10': 8,
        '123abc': 9,
      }),
      '7|8|9',
    );

    const positioned = assertRejected(['first line', '{{ 1e3 }}'].join('\n'));
    assert.equal(positioned.line, 2);
    assert.equal(positioned.column, cookiecutterCompat ? 4 : 5);
  }
});

test('halts after invalid regex replacement inputs and preserves value branches', () => {
  for (const cookiecutterCompat of [false, true]) {
    const engineEvents: string[] = [];
    const oracleEvents: string[] = [];
    const engine = createEngine({
      cookiecutterCompat,
      globals: {
        before() {
          engineEvents.push('before');
          return '';
        },
        later() {
          engineEvents.push('later');
          return '';
        },
        privileged() {
          engineEvents.push('privileged');
          return '';
        },
      },
    });
    const oracle = new nunjucks.Environment(undefined, { autoescape: false });
    for (const name of ['before', 'later', 'privileged']) {
      oracle.addGlobal(name, () => {
        oracleEvents.push(name);
        return '';
      });
    }

    for (const input of ['123', 'missing', 'null', 'false', '[1]', '{value:1}']) {
      engineEvents.length = 0;
      oracleEvents.length = 0;
      const source = `{{ before() }}{{ ${input} | replace(r/1/, "x") }}{{ later() }}`;
      const engineSource = cookiecutterCompat ? source : source.replaceAll('{{', '${{');
      assert.throws(
        () => engine.render(engineSource),
        error => error instanceof NunjitsuRenderError && error.phase === 'evaluate',
        input,
      );
      assert.throws(() => oracle.renderString(source, {}), input);
      assert.deepEqual(engineEvents, ['before'], input);
      assert.deepEqual(oracleEvents, ['before'], input);
      assert.equal(engine.render('clean'), 'clean', input);
    }

    const branchSource = [
      '{% if 123 | replace("x", "y", 0) is number %}{{ privileged() }}{% endif %}',
      '{% set x="a"|safe %}',
      '{% if x | replace(r/a/, "y") is escaped %}{{ privileged() }}{% endif %}',
    ].join('');
    const engineBranchSource = cookiecutterCompat
      ? branchSource
      : branchSource.replaceAll('{{', '${{');
    engineEvents.length = 0;
    oracleEvents.length = 0;
    assert.equal(engine.render(engineBranchSource), oracle.renderString(branchSource, {}));
    assert.deepEqual(engineEvents, []);
    assert.deepEqual(oracleEvents, []);
    assert.equal(engine.render('clean'), 'clean');
  }
});

test('empty safe-string slice fills fail before later capabilities', () => {
  for (const cookiecutterCompat of [false, true]) {
    const engineEvents: string[] = [];
    const oracleEvents: string[] = [];
    const engine = createEngine({
      cookiecutterCompat,
      globals: {
        before() {
          engineEvents.push('before');
          return '';
        },
        later() {
          engineEvents.push('later');
          return '';
        },
      },
    });
    const oracle = new nunjucks.Environment(undefined, { autoescape: false });
    for (const name of ['before', 'later']) {
      oracle.addGlobal(name, () => {
        oracleEvents.push(name);
        return '';
      });
    }
    const source = [
      '{{ before() }}',
      '{{ "abc" | slice(2, "" | safe) | dump }}',
      '{{ later() }}',
    ].join('');
    const engineSource = cookiecutterCompat
      ? source
      : source.replaceAll('{{', '${{');

    assert.throws(
      () => engine.render(engineSource),
      error => error instanceof NunjitsuRenderError && error.phase === 'evaluate',
    );
    assert.throws(() => oracle.renderString(source, {}));
    assert.deepEqual(engineEvents, ['before']);
    assert.deepEqual(oracleEvents, engineEvents);
    assert.equal(engine.render('clean'), 'clean');
  }
});

test('array-like record filters fail closed and enforce projected limits', () => {
  for (const cookiecutterCompat of [false, true]) {
    const engineEvents: string[] = [];
    const oracleEvents: string[] = [];
    const engine = createEngine({
      cookiecutterCompat,
      globals: {
        before() {
          engineEvents.push('before');
          return '';
        },
        later() {
          engineEvents.push('later');
          return '';
        },
      },
    });
    const oracle = new nunjucks.Environment(undefined, { autoescape: false });
    for (const name of ['before', 'later']) {
      oracle.addGlobal(name, () => {
        oracleEvents.push(name);
        return '';
      });
    }
    const failureExpressions = [
      '{length:-1} | reverse | dump',
      '{"0":"a","1":"b",length:1.5} | reverse | dump',
      '{length:-1} | sort | dump',
      '{"0":"a","1":"b",length:1.5} | sort | dump',
      '{length:2} | groupby("x") | dump',
      '{"0":"a",length:1} | join',
      'missing | join(",", false)',
      '("x" | safe) | join(",", "length")',
      '{"0":{x:"a"},length:-1} | join(",", "x")',
      '{"0":{x:"a"},"1":{x:"b"},length:1.5} | join(",", "x")',
      '{"0":{x:"a"},length:2} | join(",", "x")',
      '{"0":"a",length:1} | slice(1) | dump',
      '{"0":"a",length:1} | sum',
      'missing | sum(false, 7)',
      '("x" | safe) | sum("length", 7)',
      '{"0":{x:2},length:-1} | sum("x", 7)',
      '{"0":{x:2},"1":{x:3},length:1.5} | sum("x", 7)',
      '{"0":{x:2},length:2} | sum("x", 7)',
      '{"0":{x:true},length:1} | selectattr("x") | dump',
      '{"0":{x:true},length:1} | rejectattr("x") | dump',
    ];
    for (const expression of failureExpressions) {
      engineEvents.length = 0;
      oracleEvents.length = 0;
      const source = `{{ before() }}{{ ${expression} }}{{ later() }}`;
      const engineSource = cookiecutterCompat
        ? source
        : source.replaceAll('{{', '${{');
      assert.throws(
        () => engine.render(engineSource),
        error => error instanceof NunjitsuRenderError && error.phase === 'evaluate',
        expression,
      );
      assert.throws(() => oracle.renderString(source, {}), expression);
      assert.deepEqual(engineEvents, ['before'], expression);
      assert.deepEqual(oracleEvents, engineEvents, expression);
      assert.equal(engine.render('clean'), 'clean', expression);
    }

    for (const expression of [
      '{length:1000000000} | reverse | dump',
      '{length:1000000000} | join(",", "x") | dump',
      '{length:1000000000} | sum("x", 7) | dump',
    ]) {
      const largeSource = [
        '{{ before() }}',
        `{{ ${expression} }}`,
        '{{ later() }}',
      ].join('');
      const engineLargeSource = cookiecutterCompat
        ? largeSource
        : largeSource.replaceAll('{{', '${{');
      for (const limits of [
        { workUnits: 100 },
        { workUnits: Number.POSITIVE_INFINITY, scratchBytes: 100 },
      ]) {
        engineEvents.length = 0;
        assert.throws(
          () => engine.render(engineLargeSource, {}, { limits }),
          NunjitsuLimitError,
        );
        assert.deepEqual(engineEvents, ['before']);
        assert.equal(engine.render('clean'), 'clean');
      }
    }
  }
});

test('attribute lookup policies reject reserved paths and fail on nullish values', () => {
  for (const cookiecutterCompat of [false, true]) {
    const engineEvents: string[] = [];
    const oracleEvents: string[] = [];
    const engine = createEngine({
      cookiecutterCompat,
      globals: {
        before() {
          engineEvents.push('before');
          return '';
        },
        later() {
          engineEvents.push('later');
          return '';
        },
      },
    });
    const oracle = new nunjucks.Environment(undefined, { autoescape: false });
    for (const name of ['before', 'later']) {
      oracle.addGlobal(name, () => {
        oracleEvents.push(name);
        return '';
      });
    }
    const nullishExpressions = [
      '[null,null] | join(",", "x")',
      '[missing,missing] | join(",", "x")',
      '[null,null] | sum("x")',
      '[missing,missing] | sum("x")',
      '[null,null] | sort(attribute="x") | dump',
      '[null,null] | selectattr("x") | dump',
      '[missing,missing] | selectattr("x") | dump',
      '[null,null] | rejectattr("x") | dump',
      '[missing,missing] | rejectattr("x") | dump',
      '[null,null] | groupby("x") | dump',
      '[missing,missing] | groupby("x") | dump',
    ];
    for (const expression of nullishExpressions) {
      engineEvents.length = 0;
      oracleEvents.length = 0;
      const source = `{{ before() }}{{ ${expression} }}{{ later() }}`;
      const engineSource = cookiecutterCompat
        ? source
        : source.replaceAll('{{', '${{');
      assert.throws(
        () => engine.render(engineSource),
        error => error instanceof NunjitsuRenderError && error.phase === 'evaluate',
        expression,
      );
      assert.throws(() => oracle.renderString(source, {}), expression);
      assert.deepEqual(engineEvents, ['before'], expression);
      assert.deepEqual(oracleEvents, engineEvents, expression);
      assert.equal(engine.render('clean'), 'clean', expression);
    }

    const reservedExpressions = [
      '[{}] | join(",", "constructor")',
      '[{}] | sum("prototype")',
      'missing | join(",", "constructor")',
      '{} | sum("prototype")',
      '[{}] | selectattr("__proto__") | dump',
      '[{}] | sort(attribute="a.constructor") | dump',
      '[{}] | groupby("a.prototype") | dump',
    ];
    for (const expression of reservedExpressions) {
      engineEvents.length = 0;
      const source = `{{ before() }}{{ ${expression} }}{{ later() }}`;
      const engineSource = cookiecutterCompat
        ? source
        : source.replaceAll('{{', '${{');
      assert.throws(
        () => engine.render(engineSource),
        error => error instanceof NunjitsuRenderError && error.phase === 'evaluate',
        expression,
      );
      assert.deepEqual(engineEvents, ['before'], expression);
      assert.equal(engine.render('clean'), 'clean', expression);
    }

    const allowedSource = [
      '{{ [{"a.constructor":"direct"}] | join(",", "a.constructor") }}|',
      '{{ [{"a.constructor":1},{"a.constructor":2}]',
      ' | sort(attribute="a.constructor" | safe)',
      ' | join(",", "a.constructor") }}|',
      '{{ [{"a.constructor":"direct"}]',
      ' | groupby("a.constructor" | safe) | dictsort | first | first }}',
    ].join('');
    const engineAllowedSource = cookiecutterCompat
      ? allowedSource
      : allowedSource.replaceAll('{{', '${{');
    assert.equal(engine.render(engineAllowedSource), 'direct|1,2|direct');
    assert.equal(engine.render('clean'), 'clean');
  }
});

test('standalone blocks never synthesize unsupported super authority', () => {
  let engineCalls = 0;
  let oracleCalls = 0;
  const engine = createEngine({
    globals: {
      privileged() {
        engineCalls += 1;
        return 'privileged';
      },
    },
  });
  const oracle = new nunjucks.Environment(undefined, { autoescape: false });
  oracle.addGlobal('privileged', () => {
    oracleCalls += 1;
    return 'privileged';
  });
  const sources = [
    '{% block content %}${{ super() }}${{ privileged() }}{% endblock %}',
    '{% block content %}{% set parent = super %}${{ parent() }}${{ privileged() }}{% endblock %}',
    '{% block content %}{% set values = [super] %}${{ values[0]() }}${{ privileged() }}{% endblock %}',
    '{% block content %}{% set values = {parent:super} %}${{ values.parent() }}${{ privileged() }}{% endblock %}',
    '{% block content %}{% macro invokeParent() %}${{ super() }}{% endmacro %}${{ invokeParent() }}${{ privileged() }}{% endblock %}',
    '{% block outer %}{% block inner %}${{ super() }}${{ privileged() }}{% endblock %}{% endblock %}',
    '{% block content %}{% set parent %}${{ super() }}{% endset %}${{ parent }}${{ privileged() }}{% endblock %}',
    '{% macro wrapper() %}${{ caller() }}{% endmacro %}{% block content %}{% call wrapper() %}${{ super() }}{% endcall %}${{ privileged() }}{% endblock %}',
    '{% block content %}{% set parent = super() %}{% if parent == "" %}${{ privileged() }}{% endif %}{% endblock %}',
  ];
  for (const source of sources) {
    let caught: NunjitsuRenderError | undefined;
    assert.throws(
      () => engine.render(source),
      error => {
        if (!(error instanceof NunjitsuRenderError)) {
          return false;
        }
        caught = error;
        return true;
      },
      source,
    );
    assert.throws(() => oracle.renderString(source.replaceAll('${{', '{{'), {}), source);
    assert.equal(caught?.cause, undefined);
    assert.equal(caught?.phase, 'evaluate');
    assert.equal(engineCalls, 0);
    assert.equal(oracleCalls, 0);
    assert.equal(engine.render('clean'), 'clean');
  }

  let configuredCalls = 0;
  const configured = createEngine({
    globals: {
      super() {
        configuredCalls += 1;
        return 'configured';
      },
    },
  });
  assert.equal(
    configured.render('{% block content %}${{ super() }}{% endblock %}'),
    'configured',
  );
  assert.equal(configuredCalls, 1);
  assert.throws(
    () => engine.render('{% block content %}${{ super() }}{% endblock %}', { super: 'data' }),
    NunjitsuRenderError,
  );
  assert.equal(engine.render('clean'), 'clean');
});

test('call blocks target only macros and cannot discard caller authority', () => {
  let capabilityCalls = 0;
  let laterCalls = 0;
  const engine = createEngine({
    globals: {
      capability() {
        capabilityCalls += 1;
        return '';
      },
      later() {
        laterCalls += 1;
        return '';
      },
    },
  });
  const validSource = [
    '{% macro wrapper() %}[${{ caller() }}]{% endmacro %}',
    '{% call wrapper() %}body{% endcall %}',
  ].join('');
  assert.equal(engine.render(validSource), '[body]');

  for (const source of [
    '{% call capability() %}body{% endcall %}${{ later() }}',
    '{% call range(3) %}body{% endcall %}${{ later() }}',
    '{% call cycler(1,2) %}body{% endcall %}${{ later() }}',
    '{% call joiner() %}body{% endcall %}${{ later() }}',
    '{% macro wrapper() %}${{ capability(caller) }}{% endmacro %}{% call wrapper() %}body{% endcall %}${{ later() }}',
    '{% macro wrapper() %}${{ range(1, caller=caller) | dump }}{% endmacro %}{% call wrapper() %}body{% endcall %}${{ later() }}',
  ]) {
    assert.throws(() => engine.render(source), NunjitsuRenderError, source);
    assert.equal(capabilityCalls, 0, source);
    assert.equal(laterCalls, 0, source);
    assert.equal(engine.render('clean'), 'clean');
  }
});

test('validates operations before evaluating attacker-controlled operands', () => {
  const events: string[] = [];
  const engine = createEngine({
    filters: {
      known(input, argument) {
        events.push(`filter:${input}:${argument}`);
        return `${input}:${argument}`;
      },
    },
    globals: {
      capability() {
        events.push('capability');
        return '';
      },
      factory() {
        events.push('factory');
        return '';
      },
      key() {
        events.push('key');
        return 'macro';
      },
      later() {
        events.push('later');
        return '';
      },
      mark(value) {
        events.push(`mark:${value}`);
        return value;
      },
    },
  });

  const rejectedSources = [
    '{% call capability(mark("argument")) %}${{ mark("body") }}{% endcall %}${{ later() }}',
    '{% call range(mark("argument")) %}${{ mark("body") }}{% endcall %}${{ later() }}',
    '{% call missing(mark("argument")) %}${{ mark("body") }}{% endcall %}${{ later() }}',
    '${{ mark("before") }}{% call factory()() %}${{ mark("body") }}{% endcall %}${{ later() }}',
    '${{ mark("before") }}{% call holder[key()]() %}${{ mark("body") }}{% endcall %}${{ later() }}',
    '${{ mark("input") | missing(mark("argument")) }}${{ later() }}',
    '${{ mark("input") | missing }}${{ later() }}',
    '${{ mark("input") is missing(mark("argument")) }}${{ later() }}',
    '${{ mark("input") is not missing }}${{ later() }}',
    '${{ [] | select("missing") | dump }}${{ later() }}',
    '${{ [] | reject("missing") | dump }}${{ later() }}',
    '${{ "" | select("missing") | dump }}${{ later() }}',
    '${{ true | select("missing") | dump }}${{ later() }}',
  ];
  for (const source of rejectedSources) {
    events.length = 0;
    let caught: NunjitsuRenderError | undefined;
    assert.throws(
      () => engine.render(source),
      error => {
        if (!(error instanceof NunjitsuRenderError)) {
          return false;
        }
        caught = error;
        return true;
      },
      source,
    );
    assert.equal(caught?.cause, undefined, source);
    assert.deepEqual(events, [], source);
    assert.equal(engine.render('clean'), 'clean', source);
  }

  const oracleSources = rejectedSources.slice(5, 13);
  for (const source of oracleSources) {
    const oracleEvents: string[] = [];
    const oracle = new nunjucks.Environment(undefined, { autoescape: false });
    oracle.addGlobal('later', () => {
      oracleEvents.push('later');
      return '';
    });
    oracle.addGlobal('mark', (value: unknown) => {
      oracleEvents.push(`mark:${value}`);
      return value;
    });
    assert.throws(
      () => oracle.renderString(source.replaceAll('${{', '{{'), {}),
      source,
    );
    assert.deepEqual(oracleEvents, [], source);
  }

  events.length = 0;
  assert.equal(
    engine.render('${{ mark("input") | known(mark("argument")) }}'),
    'input:argument',
  );
  assert.deepEqual(events, [
    'mark:input',
    'mark:argument',
    'filter:input:argument',
  ]);

  events.length = 0;
  assert.equal(
    engine.render('${{ mark("input") is equalto(mark("input")) }}'),
    'true',
  );
  assert.deepEqual(events, ['mark:input', 'mark:input']);

  events.length = 0;
  assert.equal(
    engine.render([
      '{% macro wrapper(value) %}[${{ value }}:${{ caller() }}]{% endmacro %}',
      '{% call wrapper(mark("argument")) %}${{ mark("body") }}{% endcall %}',
    ].join('')),
    '[argument:body]',
  );
  assert.deepEqual(events, ['mark:argument', 'mark:body']);
});

test('extracts test invocations statically without evaluating ignored right-hand sides', () => {
  for (const cookiecutterCompat of [false, true]) {
    const engineEvents: string[] = [];
    const oracleEvents: string[] = [];
    const engine = createEngine({
      cookiecutterCompat,
      globals: {
        argument() {
          engineEvents.push('argument');
          return 1;
        },
        ignored() {
          engineEvents.push('ignored');
          return 1;
        },
        later() {
          engineEvents.push('later');
          return '';
        },
        leftMissing() {
          engineEvents.push('leftMissing');
          return undefined;
        },
        leftNumber() {
          engineEvents.push('leftNumber');
          return 1;
        },
      },
    });
    const oracle = new nunjucks.Environment(undefined, { autoescape: false });
    oracle.addGlobal('argument', () => {
      oracleEvents.push('argument');
      return 1;
    });
    oracle.addGlobal('ignored', () => {
      oracleEvents.push('ignored');
      return 1;
    });
    oracle.addGlobal('later', () => {
      oracleEvents.push('later');
      return '';
    });
    oracle.addGlobal('leftMissing', () => {
      oracleEvents.push('leftMissing');
      return undefined;
    });
    oracle.addGlobal('leftNumber', () => {
      oracleEvents.push('leftNumber');
      return 1;
    });
    const engineSource = (source: string): string => cookiecutterCompat
      ? source
      : source.replaceAll('{{', '${{');

    const staticMatrix = [
      '{{ 1 is "number" }}',
      '{{ 1 is "sameas"(1) }}',
      '{{ missing is [1] }}',
      '{{ missing is {a:1} }}',
      '{{ missing is (number) }}',
      '{{ missing is holder.value }}',
      '{{ missing is holder["value"] }}',
      '{{ missing is -number }}',
      '{{ missing is number + 1 }}',
      '{{ missing is number == true }}',
      '{{ missing is not [1] }}',
      '{{ (missing is [1]) in [true] }}',
      '{{ 1 is 1 | sameas }}',
      '{{ null is none }}',
    ].join('|');
    assert.equal(
      engine.render(engineSource(staticMatrix)),
      oracle.renderString(staticMatrix, {}),
    );

    const ignoredSource = [
      '{{ missing is [ignored()] }}',
      '{{ missing is {value: ignored()} }}',
      '{{ missing is (ignored()) }}',
      '{{ missing is holder[ignored()] }}',
      '{{ missing is -ignored() }}',
      '{{ missing is ignored() + 1 }}',
      '{{ missing is ignored() == true }}',
      '{{ leftMissing() is ignored() + 1 }}',
    ].join('|');
    engineEvents.length = 0;
    oracleEvents.length = 0;
    assert.equal(
      engine.render(engineSource(ignoredSource)),
      oracle.renderString(ignoredSource, {}),
    );
    assert.deepEqual(engineEvents, ['leftMissing']);
    assert.deepEqual(oracleEvents, engineEvents);

    const carriedSource = [
      '{{ leftNumber() is "sameas"(argument()) }}',
      '{{ leftNumber() is argument() | sameas }}',
    ].join('|');
    engineEvents.length = 0;
    oracleEvents.length = 0;
    assert.equal(
      engine.render(engineSource(carriedSource)),
      oracle.renderString(carriedSource, {}),
    );
    assert.deepEqual(engineEvents, [
      'leftNumber',
      'argument',
      'leftNumber',
      'argument',
    ]);
    assert.deepEqual(oracleEvents, engineEvents);

    for (const unknownSource of [
      '{{ leftNumber() is "missingTest" }}{{ later() }}',
      '{{ leftNumber() is 1 }}{{ later() }}',
      '{{ leftNumber() is true }}{{ later() }}',
      '{{ leftNumber() is r/a/ }}{{ later() }}',
    ]) {
      engineEvents.length = 0;
      oracleEvents.length = 0;
      assert.throws(
        () => engine.render(engineSource(unknownSource)),
        NunjitsuRenderError,
        unknownSource,
      );
      assert.throws(() => oracle.renderString(unknownSource, {}), unknownSource);
      assert.deepEqual(engineEvents, [], unknownSource);
      assert.deepEqual(oracleEvents, [], unknownSource);
    }

    for (const source of [
      '{{ leftNumber() is argument() | number }}{{ later() }}',
      '{{ leftMissing() is [sameas](argument()) }}{{ later() }}',
      '{{ leftNumber() is "constructor" }}{{ later() }}',
      '{% macro secret() %}secret{% endmacro %}{{ 1 is secret | divisibleby }}{{ later() }}',
    ]) {
      engineEvents.length = 0;
      assert.throws(
        () => engine.render(engineSource(source)),
        NunjitsuRenderError,
        source,
      );
      assert.deepEqual(engineEvents, [], source);
      assert.equal(engine.render('clean'), 'clean');
    }

    engineEvents.length = 0;
    assert.throws(
      () => engine.render(
        engineSource('{{ missing is [ignored()] }}'),
        {},
        { limits: { astNodes: 2 } },
      ),
      NunjitsuLimitError,
    );
    assert.deepEqual(engineEvents, []);
    assert.equal(engine.render('clean'), 'clean');
  }
});

test('record membership tracks key presence independently of its value', () => {
  let policyCalls = 0;
  let privilegedCalls = 0;
  let oraclePolicyCalls = 0;
  let oraclePrivilegedCalls = 0;
  const engine = createEngine({
    globals: {
      undefinedPolicy() {
        policyCalls += 1;
        return { approved: undefined } as never;
      },
      privileged() {
        privilegedCalls += 1;
        return 'PRIVILEGED';
      },
    },
  });
  const oracle = new nunjucks.Environment(undefined, { autoescape: false });
  oracle.addGlobal('undefinedPolicy', () => {
    oraclePolicyCalls += 1;
    return { approved: undefined };
  });
  oracle.addGlobal('privileged', () => {
    oraclePrivilegedCalls += 1;
    return 'PRIVILEGED';
  });

  const membershipSource = [
    '${{ "approved" in {"approved": missing} }}:',
    '${{ "approved" not in {"approved": missing} }}|',
    '{% set values = {"nullValue": null, "falseValue": false, "zeroValue": 0, "emptyValue": ""} %}',
    '${{ "nullValue" in values }}:',
    '${{ "falseValue" in values }}:',
    '${{ "zeroValue" in values }}:',
    '${{ "emptyValue" in values }}|',
    '${{ "missing" in values }}:',
    '${{ "missing" not in values }}|',
    '${{ "approved" in undefinedPolicy() }}:',
    '${{ "approved" not in undefinedPolicy() }}',
  ].join('');
  const expected = 'true:false|true:true:true:true|false:true|true:false';
  assert.equal(engine.render(membershipSource), expected);
  assert.equal(
    oracle.renderString(membershipSource.replaceAll('${{', '{{'), {}),
    expected,
  );
  assert.equal(policyCalls, 2);
  assert.equal(oraclePolicyCalls, 2);

  const conditionalSource = [
    '{% set policy = undefinedPolicy() %}',
    '{% if "approved" not in policy %}${{ privileged() }}{% endif %}',
  ].join('');
  assert.equal(engine.render(conditionalSource), '');
  assert.equal(
    oracle.renderString(conditionalSource.replaceAll('${{', '{{'), {}),
    '',
  );
  assert.equal(policyCalls, 3);
  assert.equal(oraclePolicyCalls, 3);
  assert.equal(privilegedCalls, 0);
  assert.equal(oraclePrivilegedCalls, 0);
  assert.equal(engine.render('clean'), 'clean');
});

test('safe strings expose only closed own-field lookup and membership', () => {
  for (const cookiecutterCompat of [false, true]) {
    const events: string[] = [];
    const oracleEvents: string[] = [];
    const engine = createEngine({
      cookiecutterCompat,
      globals: {
        mark(label, value) {
          events.push(`mark:${String(label)}`);
          return value;
        },
        privileged(label) {
          events.push(`privileged:${String(label)}`);
          return label;
        },
      },
    });
    const oracle = new nunjucks.Environment(undefined, { autoescape: false });
    oracle.addGlobal('mark', (label: unknown, value: unknown) => {
      oracleEvents.push(`mark:${String(label)}`);
      return value;
    });
    oracle.addGlobal('privileged', (label: unknown) => {
      oracleEvents.push(`privileged:${String(label)}`);
      return label;
    });

    const matrixSource = [
      '{% macro rendered() %}macro{% endmacro %}',
      '{% set safeValue="safe"|safe %}',
      '{% set escapedValue="escape"|escape %}',
      '{% set forcedValue="force"|forceescape %}',
      '{% set macroValue=rendered() %}',
      '${{ safeValue.val }}:${{ escapedValue.val }}:',
      '${{ forcedValue.val }}:${{ macroValue.val }}|',
      '${{ "length" in safeValue }}:${{ "val" in safeValue }}:',
      '${{ "safe" in safeValue }}:${{ "" in safeValue }}:',
      '${{ 0 in safeValue }}:${{ "0" in safeValue }}:',
      '${{ "missing" in safeValue }}|',
      '${{ "length" not in safeValue }}:${{ "safe" not in safeValue }}|',
      '${{ ["length"] in safeValue }}:${{ ("val"|safe) in safeValue }}:',
      '${{ [] in safeValue }}|',
      '${{ "a" in "cat" }}:${{ "" in "" }}:${{ "z" not in "cat" }}',
    ].join('');
    const engineMatrixSource = cookiecutterCompat
      ? matrixSource.replaceAll('${{', '{{')
      : matrixSource;
    const oracleMatrixSource = matrixSource.replaceAll('${{', '{{');
    const expectedMatrix = [
      'safe:escape:force:macro',
      'true:true:false:false:false:false:false',
      'false:true',
      'true:true:false',
      'true:true:true',
    ].join('|');
    assert.equal(engine.render(engineMatrixSource), expectedMatrix);
    assert.equal(oracle.renderString(oracleMatrixSource, {}), expectedMatrix);

    const numericLookupSource = [
      '{% set value="safe"|safe %}',
      '${{ value[0] }}:${{ "0" in value }}',
    ].join('');
    const engineNumericLookupSource = cookiecutterCompat
      ? numericLookupSource.replaceAll('${{', '{{')
      : numericLookupSource;
    assert.equal(engine.render(engineNumericLookupSource), 's:false');
    assert.equal(
      oracle.renderString(numericLookupSource.replaceAll('${{', '{{'), {}),
      ':false',
    );

    const branchSource = [
      '{% set value="admin"|safe %}',
      '{% if mark("content", "admin") in value %}${{ privileged("content") }}{% endif %}',
      '{% if mark("length", "length") in value %}${{ privileged("length") }}{% endif %}',
      '{% if mark("missing", "missing") not in value %}${{ privileged("missing") }}{% endif %}',
    ].join('');
    const engineBranchSource = cookiecutterCompat
      ? branchSource.replaceAll('${{', '{{')
      : branchSource;
    const oracleBranchSource = branchSource.replaceAll('${{', '{{');
    assert.equal(engine.render(engineBranchSource), 'lengthmissing');
    assert.equal(oracle.renderString(oracleBranchSource, {}), 'lengthmissing');
    assert.deepEqual(events, [
      'mark:content',
      'mark:length',
      'privileged:length',
      'mark:missing',
      'privileged:missing',
    ]);
    assert.deepEqual(oracleEvents, events);

    const inheritedSource = [
      '{% set value="safe"|safe %}',
      '${{ "toString" in value }}:${{ "indexOf" in value }}:',
      '${{ "constructor" in value }}:${{ "prototype" in value }}:',
      '${{ "__proto__" in value }}|',
      '${{ value.toString is undefined }}:${{ value.indexOf is undefined }}',
    ].join('');
    const engineInheritedSource = cookiecutterCompat
      ? inheritedSource.replaceAll('${{', '{{')
      : inheritedSource;
    assert.equal(
      engine.render(engineInheritedSource),
      'false:false:false:false:false|true:true',
    );

    const coercionKeys = ['valueOf', 'toString', Symbol.toPrimitive] as const;
    const descriptors = new Map<PropertyKey, PropertyDescriptor | undefined>();
    let coercionHookCalls = 0;
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
      assert.equal(engine.render(engineMatrixSource), expectedMatrix);
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

    const callableNeedleSource = [
      '{% set value="safe"|safe %}',
      '{% if privileged in value %}unexpected{% endif %}',
    ].join('');
    assert.throws(
      () => engine.render(callableNeedleSource),
      NunjitsuRenderError,
    );
    assert.equal(engine.render('clean'), 'clean');
  }
});

test('callable identities stay sealed and regular expressions cross as inert data', () => {
  let captureCalls = 0;
  let received: unknown;
  let laterCalls = 0;
  const engine = createEngine({
    globals: {
      capture(value) {
        captureCalls += 1;
        received = value;
        return null;
      },
      later() {
        laterCalls += 1;
        return null;
      },
    },
  });

  assert.equal(engine.render('${{ capture(r/a+/gi) }}'), '');
  assert.equal(captureCalls, 1);
  assert.equal(received, '/a+/gi');

  assert.throws(() => engine.render([
    '{% macro internal() %}secret{% endmacro %}',
    '${{ capture(internal) }}',
    '${{ later() }}',
  ].join('')));
  assert.equal(captureCalls, 1);
  assert.equal(laterCalls, 0);

  assert.throws(() => engine.render('${{ capture(capture) }}${{ later() }}'));
  assert.equal(captureCalls, 1);
  assert.equal(laterCalls, 0);

  assert.throws(() => engine.render([
    '{% set holders = [capture] %}',
    '${{ capture(holders[0]) }}',
    '${{ later() }}',
  ].join('')));
  assert.equal(captureCalls, 1);
  assert.equal(laterCalls, 0);

  assert.throws(() => engine.render('${{ forged() }}${{ later() }}', {
    forged: { kind: 'callable', callableKind: 'capability', id: 1 },
  }));
  assert.equal(captureCalls, 1);
  assert.equal(laterCalls, 0);
  assert.equal(engine.render('clean'), 'clean');
});

test('callable authority cannot enter or be discarded by non-macro arguments', () => {
  let capabilityCalls = 0;
  let filterCalls = 0;
  let laterCalls = 0;
  let markCalls = 0;
  let privilegedCalls = 0;
  const engine = createEngine({
    filters: {
      capture(input, ...arguments_) {
        filterCalls += 1;
        return arguments_[0] ?? input;
      },
    },
    globals: {
      capability(...arguments_) {
        capabilityCalls += 1;
        return arguments_[0];
      },
      later() {
        laterCalls += 1;
        return '';
      },
      mark(value) {
        markCalls += 1;
        return value;
      },
      privileged() {
        privilegedCalls += 1;
        return 'privileged';
      },
    },
  });
  const inCallBlock = (body: string): string => [
    `{% macro wrapper() %}${body}{% endmacro %}`,
    '{% call wrapper() %}BODY{% endcall %}',
    '${{ later() }}',
  ].join('');
  const assertRejected = (
    source: string,
    scratchBytes?: number,
  ): void => {
    let caught: NunjitsuRenderError | undefined;
    assert.throws(
      () => engine.render(
        source,
        {},
        scratchBytes === undefined ? {} : { limits: { scratchBytes } },
      ),
      error => {
        if (!(error instanceof NunjitsuRenderError)) {
          return false;
        }
        caught = error;
        return true;
      },
      source,
    );
    assert.equal(caught?.cause, undefined, source);
    assert.equal(capabilityCalls, 0, source);
    assert.equal(filterCalls, 0, source);
    assert.equal(laterCalls, 0, source);
    assert.equal(markCalls, 0, source);
    assert.equal(privilegedCalls, 0, source);
    assert.equal(engine.render('clean'), 'clean', source);
  };

  for (const source of [
    inCallBlock('${{ capability(caller) }}'),
    inCallBlock('${{ capability(hidden=mark(caller)) }}'),
    inCallBlock('${{ capability({"nested":[caller]}) }}'),
    '${{ capability(privileged) }}${{ later() }}',
    '${{ capability({"nested":[privileged]}) }}${{ later() }}',
  ]) {
    assertRejected(source);
  }

  const filterSources = [
    inCallBlock('${{ caller | capture }}'),
    inCallBlock('${{ "value" | capture(caller) }}'),
    inCallBlock('${{ "value" | capture(hidden=mark(caller)) }}'),
    inCallBlock('${{ "value" | capture({"nested":[caller]}) }}'),
    '${{ privileged | capture }}${{ later() }}',
    '${{ "value" | capture({"nested":[privileged]}) }}${{ later() }}',
  ];
  for (const source of filterSources) {
    assertRejected(source, 1_000_000);
    assertRejected(source, Number.POSITIVE_INFINITY);
  }

  for (const source of [
    inCallBlock('${{ cycler(caller).next()() }}'),
    '${{ cycler(privileged) }}${{ later() }}',
    inCallBlock('{% set separator = joiner() %}${{ separator(mark(caller)) }}'),
    inCallBlock('{% set cycle = cycler("value") %}${{ cycle.next(mark(caller)) }}'),
    inCallBlock('{% set cycle = cycler("value") %}${{ cycle.reset(mark(caller)) }}'),
    inCallBlock('${{ range(1, 2, 1, mark(caller)) | dump }}'),
    inCallBlock('${{ joiner(",", mark(caller)) }}'),
    inCallBlock('${{ caller is defined }}'),
    '${{ privileged is defined }}${{ later() }}',
    inCallBlock('${{ "value" is defined(hidden=mark(caller)) }}'),
    inCallBlock('${{ "value" is defined(mark(caller)) }}'),
  ]) {
    assertRejected(source);
  }

  assert.equal(engine.render([
    '{% macro inner(value) %}[${{ value() }}]{% endmacro %}',
    '{% macro outer() %}${{ inner(caller) }}{% endmacro %}',
    '{% call outer() %}BODY{% endcall %}',
  ].join('')), '[BODY]');
  assert.equal(engine.render([
    '{% macro wrapper() %}',
    '${{ caller is callable }}:${{ caller is sameas(caller) }}',
    '{% endmacro %}',
    '{% call wrapper() %}BODY{% endcall %}',
  ].join('')), 'true:true');
  assert.equal(engine.render([
    '{% set cycle = cycler("a", "b") %}',
    '${{ cycle.next() }}${{ cycle.next() }}${{ cycle.reset() }}${{ cycle.next() }}',
  ].join('')), 'aba');
  assert.equal(capabilityCalls, 0);
  assert.equal(filterCalls, 0);
  assert.equal(laterCalls, 0);
  assert.equal(markCalls, 0);
  assert.equal(privilegedCalls, 0);
});

test('callable identities cannot be laundered through rendering or built-ins', () => {
  let handleCalls = 0;
  let inspectCalls = 0;
  let laterCalls = 0;
  const engine = createEngine({
    filters: {
      inspect(value) {
        inspectCalls += 1;
        return value;
      },
    },
    globals: {
      handle() {
        handleCalls += 1;
        return 'called';
      },
      later() {
        laterCalls += 1;
        return 'later';
      },
    },
  });
  const sources = [
    '${{ handle | string | inspect }}${{ later() }}',
    '${{ handle | safe | inspect }}${{ later() }}',
    '${{ [handle] | join | inspect }}${{ later() }}',
    '${{ missing | join(",", handle) | inspect }}${{ later() }}',
    '${{ missing | join(",", ignored=handle) | inspect }}${{ later() }}',
    '${{ {hidden:handle} | join(",", "x") | inspect }}${{ later() }}',
    '${{ missing | sum(handle, 7) | inspect }}${{ later() }}',
    '${{ missing | sum(ignored=handle) | inspect }}${{ later() }}',
    '${{ {hidden:handle} | sum("x", 7) | inspect }}${{ later() }}',
    '${{ [[handle]] | urlencode | inspect }}${{ later() }}',
    '${{ [handle] | dump | inspect }}${{ later() }}',
    '${{ {"value":handle} | string | inspect }}${{ later() }}',
    '{% macro stringify(value) %}${{ value }}{% endmacro %}${{ stringify(handle) | inspect }}${{ later() }}',
    '{% set captured %}${{ handle }}{% endset %}${{ captured | inspect }}${{ later() }}',
    '{% macro wrapper() %}${{ caller() }}{% endmacro %}{% call wrapper() %}${{ handle }}{% endcall %}${{ later() }}',
    '{% set separator = joiner(handle) %}${{ separator() }}${{ separator() | inspect }}${{ later() }}',
    '${{ handle is lower }}${{ later() }}',
    '${{ handle is upper }}${{ later() }}',
  ];
  for (const source of sources) {
    assert.throws(
      () => engine.render(source, {}, { limits: { scratchBytes: Number.POSITIVE_INFINITY } }),
      NunjitsuRenderError,
      source,
    );
    assert.equal(handleCalls, 0, source);
    assert.equal(inspectCalls, 0, source);
    assert.equal(laterCalls, 0, source);
    assert.equal(engine.render('clean'), 'clean');
  }
});

test('expression groups reject empty syntax and cannot discard callable authority', () => {
  for (const cookiecutterCompat of [false, true]) {
    const events: string[] = [];
    const engine = createEngine({
      cookiecutterCompat,
      globals: {
        before() {
          events.push('before');
          return '';
        },
        after() {
          events.push('after');
          return '';
        },
        authority() {
          events.push('authority');
          return 'authority';
        },
        consume(value) {
          events.push(`consume:${String(value)}`);
          return value;
        },
      },
    });
    const renderSource = (source: string): string => (
      cookiecutterCompat ? source.replaceAll('${{', '{{') : source
    );

    for (const source of [
      '${{ before() }}${{ () }}${{ after() }}',
      '${{ before() }}{% if false %}${{ () }}{% endif %}${{ after() }}',
      '${{ before() }}${{ [()] }}${{ after() }}',
      '${{ before() }}${{ {value: ()} }}${{ after() }}',
      '${{ before() }}${{ consume(()) }}${{ after() }}',
      '${{ before() }}${{ "value" | default(()) }}${{ after() }}',
      '${{ before() }}${{ (()) }}${{ after() }}',
    ]) {
      events.length = 0;
      assert.throws(
        () => engine.render(renderSource(source)),
        NunjitsuRenderError,
        source,
      );
      assert.deepEqual(events, [], source);
      assert.equal(engine.render('clean'), 'clean');
    }

    for (const source of [
      '${{ (authority, false) }}${{ after() }}',
      '${{ ([authority], false) }}${{ after() }}',
      '{% macro allowedMacro() %}ok{% endmacro %}${{ (allowedMacro, false) }}${{ after() }}',
    ]) {
      events.length = 0;
      assert.throws(
        () => engine.render(renderSource(source)),
        NunjitsuRenderError,
        source,
      );
      assert.deepEqual(events, [], source);
      assert.equal(engine.render('clean'), 'clean');
    }

    assert.equal(
      engine.render(renderSource('{% macro allowedMacro() %}ok{% endmacro %}${{ (0, allowedMacro)() }}')),
      'ok',
    );
    events.length = 0;
    assert.equal(engine.render(renderSource('${{ (0, authority)() }}')), 'authority');
    assert.deepEqual(events, ['authority']);
  }
});

test('standard-library failures and scalar results cannot select fail-open branches', () => {
  let engineCalls = 0;
  let oracleCalls = 0;
  const engine = createEngine({
    globals: {
      privileged() {
        engineCalls += 1;
        return 'privileged';
      },
    },
  });
  const oracle = new nunjucks.Environment(undefined, { autoescape: false });
  oracle.addGlobal('privileged', () => {
    oracleCalls += 1;
    return 'privileged';
  });

  for (const source of [
    '${{ missing | string }}${{ privileged() }}',
    '${{ null | string }}${{ privileged() }}',
  ]) {
    assert.throws(() => engine.render(source), NunjitsuRenderError);
    assert.throws(() => oracle.renderString(source.replaceAll('${{', '{{'), {}));
    assert.equal(engineCalls, 0);
    assert.equal(oracleCalls, 0);
    assert.equal(engine.render('clean'), 'clean');
  }

  const branchSource = [
    '{% if true | length == 0 %}${{ privileged() }}{% endif %}',
    '{% if [1] | urlencode == "" %}${{ privileged() }}{% endif %}',
  ].join('');
  assert.equal(
    engine.render(branchSource),
    oracle.renderString(branchSource.replaceAll('${{', '{{'), {}),
  );
  assert.equal(engineCalls, 0);
  assert.equal(oracleCalls, 0);
  assert.equal(engine.render('clean'), 'clean');
});

test('numeric filter arguments cannot desynchronize capability branches', () => {
  let engineCalls = 0;
  let oracleCalls = 0;
  const engine = createEngine({
    globals: {
      privileged() {
        engineCalls += 1;
        return 'privileged';
      },
    },
  });
  const oracle = new nunjucks.Environment(undefined, { autoescape: false });
  oracle.addGlobal('privileged', () => {
    oracleCalls += 1;
    return 'privileged';
  });
  const sources = [
    '{% if missing | center("invalid") %}${{ privileged() }}{% endif %}',
    '{% if "aaaa" | replace("a", "x", -1.5) == "xxxx" %}${{ privileged() }}{% endif %}',
    '{% if "one two three" | truncate(-1) == "one two thre..." %}${{ privileged() }}{% endif %}',
    '{% if "http://example.com/path" | urlize(-1) == "<a href=\\"http://example.com/path\\">http://example.com/pat</a>" %}${{ privileged() }}{% endif %}',
  ];
  for (const source of sources) {
    assert.equal(engine.render(source), '', source);
    assert.equal(
      oracle.renderString(source.replaceAll('${{', '{{'), {}),
      '',
      source,
    );
    assert.equal(engineCalls, 0, source);
    assert.equal(oracleCalls, 0, source);
    assert.equal(engine.render('clean'), 'clean', source);
  }
});

test('built-in value types cannot desynchronize capability branches', () => {
  let engineCalls = 0;
  let oracleCalls = 0;
  const engineCaptured: unknown[] = [];
  const oracleCaptured: unknown[] = [];
  const engine = createEngine({
    globals: {
      capture(value) {
        engineCaptured.push(value);
        return '';
      },
      handle() {
        throw new Error('handle must not be called');
      },
      privileged() {
        engineCalls += 1;
        return 'privileged';
      },
    },
  });
  const oracle = new nunjucks.Environment(undefined, { autoescape: false });
  oracle.addGlobal('capture', (value: unknown) => {
    oracleCaptured.push(value);
    return '';
  });
  oracle.addGlobal('handle', () => {
    throw new Error('handle must not be called');
  });
  oracle.addGlobal('privileged', () => {
    oracleCalls += 1;
    return 'privileged';
  });

  const branchSource = [
    '{% if range(1, missing) | length == 0 %}${{ privileged() }}{% endif %}',
    '{% switch range(false, 1)[0] %}{% case 0 %}${{ privileged() }}{% endswitch %}',
    '{% if [1,2] | sum(null, "1") === 4 %}${{ privileged() }}{% endif %}',
    '{% if [1,"2"] | sum === 3 %}${{ privileged() }}{% endif %}',
    '{% set separator = joiner(1) %}{% set ignored = separator() %}{% set value = separator() %}',
    '{% if value is string %}${{ privileged() }}{% endif %}',
  ].join('');
  assert.equal(
    engine.render(branchSource),
    oracle.renderString(branchSource.replaceAll('${{', '{{'), {}),
  );
  assert.equal(engineCalls, 0);
  assert.equal(oracleCalls, 0);

  const argumentSource = [
    '${{ capture(range(false, 1)[0]) }}',
    '${{ capture([1,2] | sum(null, "1")) }}',
    '{% set separator = joiner(1) %}{% set ignored = separator() %}',
    '${{ capture(separator()) }}',
    '{% set separator = joiner(true) %}{% set ignored = separator() %}',
    '${{ capture(separator()) }}',
    '{% set separator = joiner([1,2]) %}{% set ignored = separator() %}',
    '${{ capture(separator()) }}',
    '{% set separator = joiner({"x":1}) %}{% set ignored = separator() %}',
    '${{ capture(separator()) }}',
  ].join('');
  assert.equal(
    engine.render(argumentSource),
    oracle.renderString(argumentSource.replaceAll('${{', '{{'), {}),
  );
  assert.equal(JSON.stringify(engineCaptured), '[false,"13",1,true,[1,2],{"x":1}]');
  assert.equal(JSON.stringify(oracleCaptured), JSON.stringify(engineCaptured));

  for (const source of [
    '${{ range(handle, 1) | dump }}${{ privileged() }}',
    '${{ [handle] | sum }}${{ privileged() }}',
    '{% set separator = joiner([handle]) %}${{ separator() }}${{ privileged() }}',
    '{% set separator = joiner({"value":handle}) %}${{ separator() }}${{ privileged() }}',
  ]) {
    assert.throws(() => engine.render(source), NunjitsuRenderError);
    assert.equal(engineCalls, 0);
    assert.equal(engine.render('clean'), 'clean');
  }
});

test('capability results cross the same closed value boundary', () => {
  const engine = createEngine({
    globals: {
      exposeReserved() {
        const value = Object.create(null) as Record<string, string>;
        Object.defineProperty(value, 'constructor', { enumerable: true, value: 'blocked' });
        return value;
      },
      exposeFunction() {
        return { run: () => 'blocked' } as never;
      },
    },
  });
  assert.throws(() => engine.render('${{ exposeReserved() }}'), /constructor is reserved/);
  assert.throws(() => engine.render('${{ exposeFunction() }}'), /Unsupported template value/);
});

test('derived record keys preserve the capability-boundary name invariant', () => {
  for (const { name, reserved } of semanticNameCases) {
    let calls = 0;
    let received: unknown;
    const target = {} as Record<string, unknown>;
    const engine = createEngine({
      globals: {
        capture(value) {
          calls += 1;
          received = value;
          Object.assign(target, value as object);
          return null;
        },
      },
    });
    const source = `\${{ capture([{"key":${JSON.stringify(name)},"payload":"data"}] | groupby("key")) }}`;

    if (reserved) {
      assert.throws(() => engine.render(source), /reserved/);
      assert.equal(calls, 0);
      assert.deepEqual(Reflect.ownKeys(target), []);
      assert.throws(() => new RuntimeRecord([[name, 'blocked']]), /reserved/);
    } else {
      assert.equal(engine.render(source), '');
      assert.equal(calls, 1);
      assert.ok(received && typeof received === 'object');
      assert.equal(Object.getPrototypeOf(received), null);
      assert.equal(Object.hasOwn(received, name), true);
      assert.equal(Object.isFrozen(received), true);
      assert.equal(Object.hasOwn(target, name), true);
    }
    assert.equal(Object.getPrototypeOf(target), Object.prototype);
    assert.equal(engine.render('clean'), 'clean');
  }
});

test('direct filter attributes use only explicit record keys', () => {
  const pathCases = [
    ...semanticNameCases.filter(({ name }) => name !== ''),
    { name: 'safe.__proto__.value', reserved: false },
    { name: 'safe.constructor.value', reserved: false },
    { name: 'safe.prototype.value', reserved: false },
  ];

  for (const { name: path, reserved } of pathCases) {
    let calls = 0;
    let received: unknown;
    const engine = createEngine({
      globals: {
        capture(value) {
          calls += 1;
          received = value;
          return null;
        },
      },
    });
    const item = Object.create(null) as Record<string, unknown>;
    if (reserved) {
      item.safe = 'unrelated';
    } else {
      item[path] = 'path-value';
    }

    const render = () => engine.render(
      '${{ capture([item] | join("", path)) }}',
      { item: item as never, path },
    );
    if (reserved) {
      assert.throws(render, /reserved/);
      assert.equal(calls, 0);
    } else {
      assert.equal(render(), '');
      assert.equal(calls, 1);
      assert.equal(received, 'path-value');
    }
    assert.equal(engine.render('clean'), 'clean');
  }
});

test('scope and capability identities never fall through host object names', () => {
  const allowedIdentifiers = [
    'toString',
    'valueOf',
    'hasOwnProperty',
    'toJSON',
    '__defineGetter__',
    '__defineSetter__',
    '__lookupGetter__',
    '__lookupSetter__',
    `name${'x'.repeat(4_096)}`,
  ];

  for (const name of allowedIdentifiers) {
    let globalCalls = 0;
    let filterCalls = 0;
    const globals = Object.create(null) as Record<string, () => string>;
    const filters = Object.create(null) as Record<string, (value: unknown) => string>;
    globals[name] = () => {
      globalCalls += 1;
      return 'global';
    };
    filters[name] = value => {
      filterCalls += 1;
      return `filter:${String(value)}`;
    };
    const engine = createEngine({ globals, filters: filters as never });
    assert.equal(engine.render(`\${{ ${name}() }}|\${{ "value" | ${name} }}`), 'global|filter:value');
    assert.equal(globalCalls, 1);
    assert.equal(filterCalls, 1);
    assert.equal(
      engine.render(`{% set ${name} = "scope" %}\${{ ${name} }}`),
      'scope',
    );
  }

  for (const name of ['__proto__', 'constructor', 'prototype']) {
    let calls = 0;
    const globals = Object.create(null) as Record<string, () => null>;
    const filters = Object.create(null) as Record<string, () => null>;
    globals[name] = () => {
      calls += 1;
      return null;
    };
    filters[name] = () => {
      calls += 1;
      return null;
    };
    assert.throws(() => createEngine({ globals }), /reserved/);
    assert.throws(() => createEngine({ filters: filters as never }), /reserved/);
    assert.equal(calls, 0);
  }

  for (const name of ['__proto__', 'constructor', 'prototype', '', '0', '東京', 'segment.child']) {
    let calls = 0;
    const engine = createEngine({
      globals: {
        early() {
          calls += 1;
          return null;
        },
      },
    });
    assert.throws(() => engine.render(`\${{ early() }}{% set ${name} = 1 %}`));
    assert.equal(calls, 0);
    assert.equal(engine.render('clean'), 'clean');
  }
});

test('dotted filters dispatch exact validated capability names', () => {
  for (const cookiecutterCompat of [false, true]) {
    const engineEvents: string[] = [];
    const oracleEvents: string[] = [];
    const filters = {
      plain(value: unknown) {
        engineEvents.push('plain');
        return `plain:${String(value)}`;
      },
      'tools.identity'(value: unknown) {
        engineEvents.push('tools.identity');
        return `tools.identity:${String(value)}`;
      },
      'tools.text.identity'(value: unknown) {
        engineEvents.push('tools.text.identity');
        return `tools.text.identity:${String(value)}`;
      },
    };
    const engine = createEngine({
      cookiecutterCompat,
      filters,
      globals: {
        input() {
          engineEvents.push('input');
          return 'input';
        },
        argument() {
          engineEvents.push('argument');
          return 'argument';
        },
        later() {
          engineEvents.push('later');
          return '';
        },
      },
    });
    const oracle = new nunjucks.Environment(undefined, { autoescape: false });
    for (const name of ['plain', 'tools.identity', 'tools.text.identity']) {
      oracle.addFilter(name, (value: unknown) => {
        oracleEvents.push(name);
        return `${name}:${String(value)}`;
      });
    }
    const source = [
      '{{ "x" | plain }}|',
      '{{ "x" | tools.identity }}|',
      '{{ "x" | tools.text.identity }}|',
      '{{ "x" | tools . identity }}|',
      '{{ "x" | tools. identity }}|',
      '{{ "x" | tools .identity }}|',
      '{{ "x" | tools . identity }}',
    ].join('');
    const engineSource = cookiecutterCompat
      ? source
      : source.replaceAll('{{', '${{');
    assert.equal(
      engine.render(engineSource, {
        tools: { identity: 'context-value', text: { identity: 'context-value' } },
      }),
      oracle.renderString(source, {}),
    );
    assert.deepEqual(engineEvents, [
      'plain',
      'tools.identity',
      'tools.text.identity',
      'tools.identity',
      'tools.identity',
      'tools.identity',
      'tools.identity',
    ]);
    assert.deepEqual(oracleEvents, engineEvents);

    for (const source_ of [
      '{{ input() | tools.missing(argument()) }}{{ later() }}',
      '{{ input() | tools.missing(value=argument()) }}{{ later() }}',
      '{{ input() | tools.identity(value=argument()) }}{{ later() }}',
      '{{ input() | .leading }}{{ later() }}',
      '{{ input() | trailing. }}{{ later() }}',
      '{{ input() | repeated..dot }}{{ later() }}',
      '{{ input() | a-b }}{{ later() }}',
      '{{ input() | a b }}{{ later() }}',
      '{{ input() | tools .identity }}{{ later() }}',
      '{{ input() | constructor.safe }}{{ later() }}',
      '{{ input() | safe.constructor }}{{ later() }}',
      '{{ input() | safe.constructor.name }}{{ later() }}',
      '{{ input() | safe.prototype }}{{ later() }}',
      '{{ input() | safe.name.prototype }}{{ later() }}',
      '{{ input() | safe.__proto__ }}{{ later() }}',
    ]) {
      engineEvents.length = 0;
      const rejectedSource = cookiecutterCompat
        ? source_
        : source_.replaceAll('{{', '${{');
      assert.throws(() => engine.render(rejectedSource), NunjitsuRenderError, source_);
      assert.deepEqual(engineEvents, [], source_);
      assert.equal(engine.render('clean'), 'clean');
    }
  }

  for (const name of [
    '',
    'a-b',
    'a b',
    'a\nb',
    'a\u0000b',
    'a/b',
    '0start',
    '東京',
    '.leading',
    'trailing.',
    'a..b',
    'safe.constructor',
    'safe.constructor.name',
    'safe.prototype',
    'safe.name.prototype',
    'safe.__proto__',
    'constructor.safe',
    'prototype.safe',
    '__proto__.safe',
  ]) {
    const filters = Object.create(null) as Record<string, (value: unknown) => unknown>;
    filters[name] = value => value;
    assert.throws(() => createEngine({ filters: filters as never }), name);
  }

  let accessorCalls = 0;
  const accessorRegistry = Object.create(null);
  Object.defineProperty(accessorRegistry, 'tools.identity', {
    enumerable: true,
    get() {
      accessorCalls += 1;
      return (value: unknown) => value;
    },
  });
  assert.throws(() => createEngine({ filters: accessorRegistry }));
  assert.equal(accessorCalls, 0);

  const symbolRegistry = Object.create(null);
  symbolRegistry[Symbol('filter')] = (value: unknown) => value;
  assert.throws(() => createEngine({ filters: symbolRegistry }));

  let proxyTrapCalls = 0;
  const proxyRegistry = new Proxy({}, {
    getPrototypeOf() {
      proxyTrapCalls += 1;
      return Object.prototype;
    },
    ownKeys() {
      proxyTrapCalls += 1;
      return [];
    },
  });
  assert.throws(() => createEngine({ filters: proxyRegistry }));
  assert.equal(proxyTrapCalls, 0);
});

test('filter blocks validate authority before capturing and fail closed', () => {
  for (const cookiecutterCompat of [false, true]) {
    const events: string[] = [];
    const engine = createEngine({
      cookiecutterCompat,
      filters: {
        observe(value, argument) {
          events.push(`observe:${String(value)}:${String(argument)}`);
          return value;
        },
        invalidResult() {
          events.push('invalidResult');
          return new Date() as never;
        },
        throws() {
          events.push('throws');
          throw new Error('capability failure');
        },
      },
      globals: {
        body() {
          events.push('body');
          return 'body';
        },
        argument() {
          events.push('argument');
          return 'argument';
        },
        later() {
          events.push('later');
          return 'later';
        },
        authority() {
          events.push('authority');
          return 'authority';
        },
      },
    });
    const renderSource = (source: string): string => (
      cookiecutterCompat ? source.replaceAll('${{', '{{') : source
    );

    for (const source of [
      '{% filter missing(argument()) %}${{ body() }}{% endfilter %}${{ later() }}',
      '{% filter observe(value=argument()) %}${{ body() }}{% endfilter %}${{ later() }}',
      '{% filter observe %}${{ authority }}{% endfilter %}${{ later() }}',
      '{% filter observe(authority) %}body{% endfilter %}${{ later() }}',
      '{% filter invalidResult %}body{% endfilter %}${{ later() }}',
      '{% filter throws %}body{% endfilter %}${{ later() }}',
    ]) {
      events.length = 0;
      assert.throws(
        () => engine.render(renderSource(source)),
        NunjitsuRenderError,
        source,
      );
      assert.equal(events.includes('later'), false, source);
      if (source.includes('missing') || source.includes('value=')) {
        assert.deepEqual(events, [], source);
      }
      assert.equal(engine.render('clean'), 'clean');
    }

    for (const source of [
      '${{ body() }}{% filter %}body{% endfilter %}${{ later() }}',
      '${{ body() }}{% filter observe %}body{% endfilter trailing %}${{ later() }}',
      '${{ body() }}{% filter observe %}body${{ later() }}',
      '${{ body() }}{% filter tools. %}body{% endfilter %}${{ later() }}',
      '${{ body() }}{% filter safe.constructor %}body{% endfilter %}${{ later() }}',
    ]) {
      events.length = 0;
      assert.throws(
        () => engine.render(renderSource(source)),
        NunjitsuRenderError,
        source,
      );
      assert.deepEqual(events, [], source);
      assert.equal(engine.render('clean'), 'clean');
    }

    assert.throws(
      () => engine.render(
        renderSource('{% filter observe %}captured output{% endfilter %}'),
        {},
        { limits: { outputCodeUnits: 4 } },
      ),
      NunjitsuLimitError,
    );
    assert.equal(engine.render('clean'), 'clean');
  }
});

test('capability results are recopied before reaching another capability', () => {
  for (const { name, reserved } of semanticNameCases) {
    let producerCalls = 0;
    let sinkCalls = 0;
    let received: unknown;
    const target = {} as Record<string, unknown>;
    const engine = createEngine({
      globals: {
        produce() {
          producerCalls += 1;
          const value = Object.create(null) as Record<string, string>;
          value[name] = 'result';
          return value;
        },
        sink(value) {
          sinkCalls += 1;
          received = value;
          Object.assign(target, value as object);
          return null;
        },
      },
    });

    if (reserved) {
      assert.throws(() => engine.render('${{ sink(produce()) }}'), /reserved/);
      assert.equal(producerCalls, 1);
      assert.equal(sinkCalls, 0);
      assert.deepEqual(Reflect.ownKeys(target), []);
    } else {
      assert.equal(engine.render('${{ sink(produce()) }}'), '');
      assert.equal(producerCalls, 1);
      assert.equal(sinkCalls, 1);
      assert.ok(received && typeof received === 'object');
      assert.equal(Object.getPrototypeOf(received), null);
      assert.equal(Object.hasOwn(received, name), true);
      assert.equal(Object.hasOwn(target, name), true);
    }
    assert.equal(Object.getPrototypeOf(target), Object.prototype);
    assert.equal(engine.render('clean'), 'clean');
  }
});

test('capability exceptions retain only inert sanitized messages and halt evaluation', () => {
  let messageReads = 0;
  let proxyTraps = 0;
  let exoticHooks = 0;
  let laterCalls = 0;
  const getterError = new Error();
  Object.defineProperty(getterError, 'message', {
    get() {
      messageReads += 1;
      return 'must not be read';
    },
  });
  const proxyError = new Proxy(new Error('must not be retained'), {
    get(target, property, receiver) {
      proxyTraps += 1;
      return Reflect.get(target, property, receiver);
    },
    getOwnPropertyDescriptor(target, property) {
      proxyTraps += 1;
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
    getPrototypeOf(target) {
      proxyTraps += 1;
      return Reflect.getPrototypeOf(target);
    },
    ownKeys(target) {
      proxyTraps += 1;
      return Reflect.ownKeys(target);
    },
  });
  const customInspect = Symbol.for('nodejs.util.inspect.custom');
  const exotic = {
    toString() {
      exoticHooks += 1;
      return 'must not run';
    },
    toJSON() {
      exoticHooks += 1;
      return 'must not run';
    },
    [Symbol.toPrimitive]() {
      exoticHooks += 1;
      return 'must not run';
    },
    [customInspect]() {
      exoticHooks += 1;
      return 'must not run';
    },
  };
  const engine = createEngine({
    filters: {
      failUseful() {
        throw new Error('useful message');
      },
    },
    globals: {
      failString() {
        throw 'first\nsecond\u001b[31m';
      },
      failGetter() {
        throw getterError;
      },
      failProxy() {
        throw proxyError;
      },
      failExotic() {
        throw exotic;
      },
      failLong() {
        throw new Error('x'.repeat(5_000));
      },
      later() {
        laterCalls += 1;
        return 'not reached';
      },
    },
  });

  const failureCases = [
    {
      source: 'before${{ "value" | failUseful }}${{ later() }}',
      message: 'Template filter "failUseful" failed: useful message',
    },
    {
      source: 'before${{ failString() }}${{ later() }}',
      message: 'Template global "failString" failed: first\\u000asecond\\u001b[31m',
    },
    {
      source: 'before${{ failGetter() }}${{ later() }}',
      message: 'Template global "failGetter" failed',
    },
    {
      source: 'before${{ failProxy() }}${{ later() }}',
      message: 'Template global "failProxy" failed',
    },
    {
      source: 'before${{ failExotic() }}${{ later() }}',
      message: 'Template global "failExotic" failed',
    },
  ];
  for (const { source, message } of failureCases) {
    let caught: NunjitsuRenderError | undefined;
    assert.throws(
      () => engine.render(source),
      error => {
        if (!(error instanceof NunjitsuRenderError)) {
          return false;
        }
        caught = error;
        return true;
      },
    );
    assert.match(caught?.message ?? '', /^Template error at line 1, column \d+: /);
    assert.ok(caught?.message.endsWith(message));
    assert.equal(caught?.code, 'capability_error');
    assert.equal(caught?.cause, undefined);
    inspect(caught, { showHidden: true, depth: 5 });
    JSON.stringify(caught, ['name', 'message', 'cause']);
    assert.equal(messageReads, 0);
    assert.equal(proxyTraps, 0);
    assert.equal(exoticHooks, 0);
    assert.equal(laterCalls, 0);
    assert.equal(engine.render('clean'), 'clean');
  }

  let longError: NunjitsuRenderError | undefined;
  assert.throws(
    () => engine.render('${{ failLong() }}${{ later() }}'),
    error => {
      if (!(error instanceof NunjitsuRenderError)) {
        return false;
      }
      longError = error;
      return true;
    },
  );
  assert.match(
    longError?.message ?? '',
    /^Template error at line 1, column 5: Template global "failLong" failed: x+…$/,
  );
  assert.ok((longError?.message.length ?? 0) <= 1_025);
  assert.equal(longError?.code, 'capability_error');
  assert.equal(longError?.cause, undefined);
  assert.equal(laterCalls, 0);
  assert.equal(engine.render('clean'), 'clean');
});

test('parser diagnostics neutralize untrusted token content', () => {
  const engine = createEngine();
  const unsafeDiagnosticCharacterPattern = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
  const values = [
    'first-line\nsecond-line',
    '\u0000\u001f\u007f\u0085\u009b',
    bidiControlCharacters.join(''),
    '\u001b[31mFORGED\u001b[0m',
    '\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007',
    'x'.repeat(1_000) + 'TRUNCATED-TAIL',
    'ordinary printable value',
  ];

  for (const value of values) {
    const source = '${{ target."' + value + '" }}';
    let parseMessage = '';
    assert.throws(
      () => parseTemplate(source),
      error => {
        if (!(error instanceof NunjitsuParseError)) {
          return false;
        }
        parseMessage = error.message;
        return true;
      },
    );
    let renderMessage = '';
    assert.throws(
      () => engine.render(source, { target: {} }),
      error => {
        if (!(error instanceof NunjitsuRenderError)) {
          return false;
        }
        renderMessage = error.message;
        return true;
      },
    );
    for (const message of [parseMessage, renderMessage]) {
      assert.doesNotMatch(message, unsafeDiagnosticCharacterPattern);
      assert.ok(message.length < 300);
      assert.match(message, /Expected name, received "/);
    }
    assert.equal(engine.render('clean'), 'clean');
  }

  const printableSource = '${{ target."ordinary printable value" }}';
  assert.throws(
    () => engine.render(printableSource, { target: {} }),
    error => (
      error instanceof NunjitsuRenderError &&
      error.message.includes('"ordinary printable value"')
    ),
  );

  const evaluatorSource = '${{ [1] | select("first\\nsecond' + '\u001b' + '[31m") | list }}';
  assert.throws(
    () => engine.render(evaluatorSource),
    error => (
      error instanceof NunjitsuRenderError &&
      !unsafeDiagnosticCharacterPattern.test(error.message) &&
      error.message.includes('first\\u000asecond\\u001b[31m')
    ),
  );
  const longEvaluatorSource = '${{ [1] | select(' + JSON.stringify('x'.repeat(2_000)) + ') }}';
  assert.throws(
    () => engine.render(longEvaluatorSource),
    error => error instanceof NunjitsuRenderError && error.message.length <= 1_025,
  );

  for (const character of bidiControlCharacters) {
    const source = '${{ value["LEFT' + character + 'RIGHT"]() }}';
    let caught: NunjitsuRenderError | undefined;
    assert.throws(
      () => engine.render(source, { value: {} }),
      error => {
        if (!(error instanceof NunjitsuRenderError)) {
          return false;
        }
        caught = error;
        return true;
      },
    );
    const escaped = `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;
    assert.ok(!caught?.message.includes(character), escaped);
    assert.ok(caught?.message.includes(escaped), escaped);
    assert.ok(!inspect(caught, { showHidden: true }).includes(character), escaped);
  }
});

test('public render diagnostics expose safe structure without internal causes', () => {
  const unsafeControlPattern = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
  const source = '${{ value["FORGED\\n' + '\u001b' + ']52;c;YXR0YWNrZXI=' +
    '\u0007' + '\u202e' + 'TXT"]() }}';
  let evaluationError: NunjitsuRenderError | undefined;
  assert.throws(
    () => createEngine().render(source, { value: {} }),
    error => {
      if (!(error instanceof NunjitsuRenderError)) {
        return false;
      }
      evaluationError = error;
      return true;
    },
  );
  assert.equal(evaluationError?.phase, 'evaluate');
  assert.equal(evaluationError?.code, 'evaluation_error');
  assert.equal(evaluationError?.line, 1);
  assert.equal(evaluationError?.column, 11);
  assert.equal(evaluationError?.cause, undefined);
  assert.match(evaluationError?.message ?? '', /FORGED\\n\\u001b/);
  const inspectedEvaluationError = inspect(evaluationError, { showHidden: true, depth: 5 });
  assert.doesNotMatch(inspectedEvaluationError, unsafeControlPattern);
  assert.ok(!inspectedEvaluationError.includes('FORGED\n'));

  let parseError: NunjitsuRenderError | undefined;
  assert.throws(
    () => createEngine().render('first line\n${{ broken( }}'),
    error => {
      if (!(error instanceof NunjitsuRenderError)) {
        return false;
      }
      parseError = error;
      return true;
    },
  );
  assert.equal(parseError?.phase, 'parse');
  assert.equal(parseError?.code, 'syntax_error');
  assert.equal(parseError?.line, 2);
  assert.equal(parseError?.column, 13);
  assert.equal(parseError?.cause, undefined);

  const capabilityEngine = createEngine({
    globals: {
      fail() {
        throw new Error('capability\n\u001b[31m');
      },
    },
  });
  let capabilityError: NunjitsuRenderError | undefined;
  assert.throws(
    () => capabilityEngine.render('prefix ${{ fail() }}'),
    error => {
      if (!(error instanceof NunjitsuRenderError)) {
        return false;
      }
      capabilityError = error;
      return true;
    },
  );
  assert.equal(capabilityError?.phase, 'evaluate');
  assert.equal(capabilityError?.code, 'capability_error');
  assert.equal(capabilityError?.line, 1);
  assert.equal(capabilityError?.column, 12);
  assert.equal(capabilityError?.cause, undefined);
  assert.doesNotMatch(inspect(capabilityError, { showHidden: true }), unsafeControlPattern);
  assert.equal(capabilityEngine.render('clean'), 'clean');
});

test('clears ambient legacy RegExp state after every render', () => {
  const engine = createEngine();
  const assertLegacyStateCleared = (): void => {
    assert.equal(RegExp.$1, '');
    assert.equal(RegExp.$2, '');
    assert.equal(RegExp.$3, '');
    assert.equal(RegExp.$4, '');
    assert.equal(RegExp.$5, '');
    assert.equal(RegExp.$6, '');
    assert.equal(RegExp.$7, '');
    assert.equal(RegExp.$8, '');
    assert.equal(RegExp.$9, '');
    assert.equal(RegExp.input, '');
    assert.equal(RegExp.lastMatch, '');
    assert.equal(RegExp.lastParen, '');
    assert.equal(RegExp.leftContext, '');
    assert.equal(RegExp.rightContext, '');
  };
  const seedLegacyState = (): void => {
    /PREVIOUS:(.*)/.exec('PREVIOUS:ambient');
    assert.equal(RegExp.$1, 'ambient');
  };

  assert.equal(
    engine.render('${{ "ATTACK:owned" | replace(r/ATTACK:(.*)/, "x") }}'),
    'x',
  );
  assertLegacyStateCleared();

  assert.throws(
    () => engine.render([
      '${{ "FAIL:secret" | replace(r/FAIL:(.*)/, "x") }}',
      '${{ missing() }}',
    ].join('')),
    error => error instanceof NunjitsuRenderError,
  );
  assertLegacyStateCleared();

  seedLegacyState();
  assert.throws(
    () => engine.render('${{'),
    error => error instanceof NunjitsuRenderError,
  );
  assertLegacyStateCleared();

  seedLegacyState();
  assert.equal(engine.render('clean'), 'clean');
  assertLegacyStateCleared();
});

test('isolates capabilities from template-controlled legacy RegExp state', () => {
  const readLegacyState = (): readonly string[] => [
    RegExp.$1,
    RegExp.$2,
    RegExp.$3,
    RegExp.$4,
    RegExp.$5,
    RegExp.$6,
    RegExp.$7,
    RegExp.$8,
    RegExp.$9,
    RegExp.input,
    RegExp.lastMatch,
    RegExp.lastParen,
    RegExp.leftContext,
    RegExp.rightContext,
  ];
  const emptyLegacyState = Array.from({ length: 14 }, () => '');
  const observations: Array<readonly string[]> = [];
  const observe = (): string => {
    observations.push(readLegacyState());
    return '';
  };
  const assertLastObservationCleared = (): void => {
    assert.deepEqual(observations.at(-1), emptyLegacyState);
  };
  let laterCalls = 0;

  const engine = createEngine({
    filters: {
      observe(input) {
        observe();
        return input;
      },
    },
    globals: {
      observe,
      poison() {
        /CAPABILITY:(.*)/.exec('CAPABILITY:poisoned');
        return '';
      },
      invalidResult() {
        /RESULT:(.*)/.exec('RESULT:poisoned');
        return (() => 'unsupported') as never;
      },
      fail() {
        /FAILURE:(.*)/.exec('FAILURE:poisoned');
        throw new Error('expected failure');
      },
      later() {
        laterCalls += 1;
        return '';
      },
    },
  });

  assert.equal(
    engine.render('${{ "ATTACK:owned" | replace(r/ATTACK:(.*)/, "redacted") }}${{ observe() }}'),
    'redacted',
  );
  assertLastObservationCleared();

  assert.equal(
    engine.render('${{ "FILTER:owned" | replace(r/FILTER:(.*)/, "redacted") }}${{ "value" | observe }}'),
    'redactedvalue',
  );
  assertLastObservationCleared();

  /PREVIOUS:(.*)/.exec('PREVIOUS:ambient');
  assert.equal(RegExp.$1, 'ambient');
  engine.render('${{ r/PARSER:(.*)/ }}${{ observe() }}');
  assertLastObservationCleared();

  assert.equal(engine.render('${{ poison() }}${{ observe() }}'), '');
  assertLastObservationCleared();

  assert.throws(
    () => engine.render('${{ invalidResult() }}${{ later() }}'),
    error => error instanceof NunjitsuRenderError,
  );
  assert.deepEqual(readLegacyState(), emptyLegacyState);
  assert.equal(laterCalls, 0);

  assert.throws(
    () => engine.render('${{ fail() }}${{ later() }}'),
    error => (
      error instanceof NunjitsuRenderError &&
      error.message ===
        'Template error at line 1, column 5: Template global "fail" failed: expected failure'
    ),
  );
  assert.deepEqual(readLegacyState(), emptyLegacyState);
  assert.equal(laterCalls, 0);

  let nestedStateAfterRender: readonly string[] | undefined;
  const innerEngine = createEngine({
    globals: {
      observeInner: observe,
      poisonInner() {
        /INNER:(.*)/.exec('INNER:poisoned');
        return '';
      },
    },
  });
  const outerEngine = createEngine({
    globals: {
      nested() {
        /OUTER:(.*)/.exec('OUTER:poisoned');
        innerEngine.render('${{ observeInner() }}${{ poisonInner() }}');
        nestedStateAfterRender = readLegacyState();
        /OUTER_RETURN:(.*)/.exec('OUTER_RETURN:poisoned');
        return '';
      },
      observe,
    },
  });
  assert.equal(outerEngine.render('${{ nested() }}${{ observe() }}'), '');
  assert.deepEqual(nestedStateAfterRender, emptyLegacyState);
  assert.deepEqual(observations.at(-2), emptyLegacyState);
  assertLastObservationCleared();
  assert.deepEqual(readLegacyState(), emptyLegacyState);

  assert.equal(engine.render('${{ observe() }}'), '');
  assertLastObservationCleared();
});

test('parser and evaluator sources contain no dynamic execution primitive', async () => {
  const files = [
    '../../src/parser/index.ts',
    '../../src/parser/parseTemplate.ts',
    '../../src/parser/expression.ts',
    '../../src/runtime/evaluator.ts',
    '../../src/runtime/builtins.ts',
    '../../src/runtime/coercion.ts',
    '../../src/runtime/scope.ts',
  ];
  const prohibited = [
    /\beval\s*\(/,
    /\bFunction\s*\(/,
    /\bnew\s+Function\b/,
    /node:vm/,
    /\bimport\s*\(/,
    /\bReflect\./,
    /Object\.getPrototypeOf/,
    /Object\.getOwnPropertyDescriptor/,
  ];
  for (const file of files) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    for (const pattern of prohibited) {
      assert.doesNotMatch(source, pattern, `${file} contains ${pattern}`);
    }
    assert.doesNotMatch(source, /from ['"]nunjucks['"]/, `${file} imports Nunjucks`);
  }
});
