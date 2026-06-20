import assert from 'node:assert/strict';
import test from 'node:test';

import { createEngine, markSafe, memoryLoader } from '../../dist/esm/index.js';

test('renders through the ESM package entry', async () => {
  const engine = await createEngine({
    autoescape: true,
    filters: {
      upper(input) {
        return String(input).toUpperCase();
      },
    },
    loaders: [memoryLoader({
      'entry.njk': 'ESM {% include "value.njk" %}',
      'value.njk': '{{ value }}',
    })],
  });
  try {
    assert.equal(
      await engine.render({ name: 'entry.njk' }, { value: markSafe('<b>works</b>') }),
      'ESM <b>works</b>',
    );
    assert.equal(
      (await Array.fromAsync(
        engine.renderStream({ source: 'stream {{ value | upper }}' }, { value: 'works' }),
      )).join(''),
      'stream WORKS',
    );
  } finally {
    await engine.dispose();
  }
});
