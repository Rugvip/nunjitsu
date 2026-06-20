import assert from 'node:assert/strict';
import test from 'node:test';

import { createEngine, markSafe, memoryLoader } from '../../dist/esm/index.js';

test('renders through the ESM package entry', async () => {
  const engine = await createEngine({
    autoescape: true,
    loaders: [memoryLoader({ 'entry.njk': 'ESM {{ value }}' })],
  });
  try {
    assert.equal(
      await engine.render({ name: 'entry.njk' }, { value: markSafe('<b>works</b>') }),
      'ESM <b>works</b>',
    );
  } finally {
    await engine.dispose();
  }
});
