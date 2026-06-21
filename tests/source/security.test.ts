import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createEngine, NunjitsuRenderError } from '../../src/index.ts';
import { RuntimeScope } from '../../src/runtime/scope.ts';
import {
  copyPublicValue,
  copyRuntimeContext,
  copyRuntimeValue,
  RuntimeArray,
  RuntimeRecord,
  withRuntimeContextPath,
} from '../../src/runtime/value.ts';

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

test('capability exceptions halt evaluation without inspecting thrown values', () => {
  let messageReads = 0;
  let laterCalls = 0;
  const thrown = new Error();
  Object.defineProperty(thrown, 'message', {
    get() {
      messageReads += 1;
      return 'must not be read';
    },
  });
  const engine = createEngine({
    filters: {
      fail() {
        throw thrown;
      },
    },
    globals: {
      failWithTypeError() {
        throw new TypeError('opaque');
      },
      later() {
        laterCalls += 1;
        return 'not reached';
      },
    },
  });

  assert.throws(
    () => engine.render('before${{ "value" | fail }}${{ later() }}'),
    error => (
      error instanceof NunjitsuRenderError &&
      error.message === 'Template capability failed' &&
      error.cause instanceof Error &&
      error.cause.cause === thrown
    ),
  );
  assert.equal(messageReads, 0);
  assert.equal(laterCalls, 0);

  assert.throws(
    () => engine.render('${{ failWithTypeError() }}${{ later() }}'),
    error => error instanceof NunjitsuRenderError,
  );
  assert.equal(laterCalls, 0);
  assert.equal(engine.render('clean'), 'clean');
});

test('parser and evaluator sources contain no dynamic execution primitive', async () => {
  const files = [
    '../../src/parser/index.ts',
    '../../src/parser/expression.ts',
    '../../src/runtime/evaluator.ts',
    '../../src/runtime/builtins.ts',
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
