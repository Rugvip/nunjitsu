import assert from 'node:assert/strict';
import test from 'node:test';

import { memoryLoader } from '../../src/loaders.ts';
import { createNativeEngine } from '../../src/native-engine.ts';
import { markSafe } from '../../src/values.ts';

test('constructs synchronously and renders inline and loaded templates', async () => {
  const engine = createNativeEngine({
    loaders: [memoryLoader({
      'entry.njk': 'loaded {% include "partial.njk" %}',
      'partial.njk': '{{ value }}',
    })],
  });

  assert.equal(
    await engine.render({ source: 'inline {{ value }}' }, { value: '<x>' }),
    'inline &lt;x&gt;',
  );
  assert.equal(
    await engine.render({ name: 'entry.njk' }, { value: markSafe('<x>') }),
    'loaded <x>',
  );
});

test('invokes only explicit copied capabilities', async () => {
  const input = { nested: { value: 'safe' } };
  const engine = createNativeEngine({
    filters: {
      async inspect(value, arguments_) {
        assert.equal(Object.getPrototypeOf(value), null);
        assert.ok(Object.isFrozen(value));
        assert.deepEqual(arguments_, ['suffix']);
        return `${(value as { nested: { value: string } }).nested.value}-suffix`;
      },
    },
    globals: {
      answer() {
        return 42;
      },
    },
  });

  assert.equal(
    await engine.render(
      { source: '{{ input | inspect("suffix") }}={{ answer() }}' },
      { input },
    ),
    'safe-suffix=42',
  );
});
