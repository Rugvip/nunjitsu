import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { inspect } from 'node:util';
import nunjucks from 'nunjucks';

import { createEngine, NunjitsuRenderError } from '../../src/index.ts';
import { NunjitsuParseError, parseTemplate } from '../../src/parser/index.ts';
import { applyBuiltinFilter } from '../../src/runtime/builtins.ts';
import { RuntimeScope } from '../../src/runtime/scope.ts';
import {
  copyPublicValue,
  copyRuntimeContext,
  copyRuntimeValue,
  RuntimeArray,
  RuntimeRecord,
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
        return error.message ===
          'Template capability failed: Proxy objects cannot be used as template values';
      },
    );
    assert.ok(caught?.cause instanceof Error);
    assert.notEqual(caught.cause, trapFailure);
    assert.equal(caught.cause.cause, undefined);
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
  assert.equal(engine.render('clean'), 'clean');
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

test('dynamic attribute paths traverse only explicit record entries', () => {
  const pathCases = [
    ...semanticNameCases,
    { name: 'safe.__proto__.value', reserved: true },
    { name: 'safe.constructor.value', reserved: true },
    { name: 'safe.prototype.value', reserved: true },
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
      const segments = path.split('.');
      let current = item;
      for (const [index, segment] of segments.entries()) {
        if (index === segments.length - 1) {
          current[segment] = 'path-value';
        } else {
          const child = Object.create(null) as Record<string, unknown>;
          current[segment] = child;
          current = child;
        }
      }
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
      message: 'Template capability failed: useful message',
    },
    {
      source: 'before${{ failString() }}${{ later() }}',
      message: 'Template capability failed: first\\u000asecond\\u001b[31m',
    },
    { source: 'before${{ failGetter() }}${{ later() }}', message: 'Template capability failed' },
    { source: 'before${{ failProxy() }}${{ later() }}', message: 'Template capability failed' },
    { source: 'before${{ failExotic() }}${{ later() }}', message: 'Template capability failed' },
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
    assert.equal(caught?.message, message);
    assert.ok(caught?.cause instanceof Error);
    assert.equal(caught.cause.cause, undefined);
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
  assert.match(longError?.message ?? '', /^Template capability failed: x+…$/);
  assert.ok((longError?.message.length ?? 0) <= 1_025);
  assert.ok(longError?.cause instanceof Error);
  assert.equal(longError.cause.cause, undefined);
  assert.equal(laterCalls, 0);
  assert.equal(engine.render('clean'), 'clean');
});

test('parser diagnostics neutralize untrusted token content', () => {
  const engine = createEngine();
  const unsafeDiagnosticCharacterPattern = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
  const values = [
    'first-line\nsecond-line',
    '\u0000\u001f\u007f\u0085\u009b',
    '\u001b[31mFORGED\u001b[0m',
    '\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007',
    'x'.repeat(1_000) + 'TRUNCATED-TAIL',
    'ordinary printable value',
  ];

  for (const value of values) {
    const source = '${{ target.' + JSON.stringify(value) + ' }}';
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
      assert.match(message, /^Expected name, received "/);
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

  const evaluatorSource = '${{ [1] | select("first\\nsecond\\u001b[31m") | list }}';
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
      error.message === 'Template capability failed: expected failure'
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
