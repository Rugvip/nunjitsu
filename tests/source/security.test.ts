import assert from 'node:assert/strict';
import test from 'node:test';

import { markSafe } from '../../src/values.ts';
import { RuntimeScope } from '../../src/runtime/scope.ts';
import {
  copyPublicValue,
  copyRuntimeContext,
  copyRuntimeValue,
  RuntimeArray,
  RuntimeRecord,
  RuntimeSafeString,
} from '../../src/runtime/value.ts';

test('copies only closed values without invoking rejected accessors', () => {
  let getterCalls = 0;
  const withGetter = Object.defineProperty({}, 'secret', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'leaked';
    },
  });
  assert.throws(
    () => copyRuntimeValue(withGetter),
    /cannot contain accessors/,
  );
  assert.equal(getterCalls, 0);

  class HostValue {
    value = 'host';
  }
  assert.throws(
    () => copyRuntimeValue(new HostValue()),
    /Only plain records/,
  );
  assert.throws(
    () => copyRuntimeValue(Object.assign([1], { extra: 2 })),
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

test('reserves prototype gadget names across values and scopes', () => {
  for (const name of ['constructor', 'prototype', '__proto__']) {
    const context = Object.create(null) as Record<string, string>;
    context[name] = 'blocked';
    assert.throws(
      () => copyRuntimeContext(context),
      new RegExp(`key ${name} is reserved`),
    );

    const scope = new RuntimeScope();
    assert.throws(() => scope.set(name, 'blocked'), /is reserved/);
    assert.equal(scope.get(name), undefined);
  }

  const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'polluted');
  Object.defineProperty(Object.prototype, 'polluted', {
    configurable: true,
    value: 'host',
  });
  try {
    const copied = copyRuntimeContext({ own: 'value' });
    assert.equal(copied.get('own'), 'value');
    assert.equal(copied.get('polluted'), undefined);
  } finally {
    if (previous) {
      Object.defineProperty(Object.prototype, 'polluted', previous);
    } else {
      delete (Object.prototype as Record<string, unknown>).polluted;
    }
  }
});

test('owns aliases and exposes only frozen callback copies', () => {
  const shared = { value: markSafe('<trusted>') };
  const copied = copyRuntimeValue([shared, shared]);
  assert.ok(copied instanceof RuntimeArray);
  const first = copied.at(0);
  const second = copied.at(1);
  assert.equal(first, second);
  assert.ok(first instanceof RuntimeRecord);
  assert.ok(first.get('value') instanceof RuntimeSafeString);

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

test('scope lookup never falls through to host globals or prototypes', () => {
  const root = new RuntimeScope();
  root.set('value', 1);
  const child = root.child();
  child.set('local', 2);

  assert.equal(child.get('value'), 1);
  assert.equal(child.get('local'), 2);
  assert.equal(child.get('process'), undefined);
  assert.equal(child.get('globalThis'), undefined);
  assert.equal(child.get('toString'), undefined);
  assert.equal(child.get('constructor'), undefined);
});
