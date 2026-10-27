import assert from 'node:assert/strict';
import test from 'node:test';

import { hostTypes, randomInteger, utf8ByteLength } from '../../src/runtime/platform.browser.ts';

test('browser platform preserves UTF-8 accounting and checks native container brands', () => {
  const units = [0, 0x7f, 0x80, 0x7ff, 0x800, 0xd800, 0xdbff, 0xdc00, 0xdfff, 0xffff];
  for (const first of units) {
    for (const second of units) {
      const value = String.fromCharCode(first, second);
      assert.equal(utf8ByteLength(value), Buffer.byteLength(value));
    }
  }
  assert.equal(utf8ByteLength('Hello 世界 🌍'), Buffer.byteLength('Hello 世界 🌍'));
  assert.equal(hostTypes.isMap(new Map()), true);
  assert.equal(hostTypes.isSet(new Set()), true);
  for (const value of [null, {}, Object.create(Map.prototype), Object.create(Set.prototype)]) {
    assert.equal(hostTypes.isMap(value), false);
    assert.equal(hostTypes.isSet(value), false);
  }
  const proxy = new Proxy({}, {
    get() { throw new Error('must not inspect values during branding'); },
    getPrototypeOf() { throw new Error('must not inspect prototypes during branding'); },
  });
  assert.equal(hostTypes.isProxy(proxy), false);
  assert.equal(hostTypes.isMap(proxy), false);
  assert.equal(hostTypes.isSet(proxy), false);
  assert.equal(hostTypes.isNativeError(proxy), false);
});

test('browser randomness rejects biased samples and invalid ranges without Math.random', t => {
  t.mock.method(Math, 'random', () => { throw new Error('must use cryptographic randomness'); });
  let calls = 0;
  t.mock.method(globalThis.crypto, 'getRandomValues', (array: Uint32Array) => {
    calls += 1;
    array[0] = calls === 1 ? 0xffff_ffff : 0;
    array[1] = calls === 1 ? 0xffff_ffff : 0x0007_0000;
    return array;
  });
  assert.equal(randomInteger(10), 7);
  assert.equal(calls, 2);
  assert.equal(randomInteger(1), 0);
  assert.equal(randomInteger(2 ** 32), 7);
  for (const maximum of [0, -1, 1.5, NaN, Infinity, 2 ** 48]) {
    assert.throws(() => randomInteger(maximum), RangeError);
  }
});
