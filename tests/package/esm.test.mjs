import assert from 'node:assert/strict';
import test from 'node:test';

import { createEngine, memoryLoader } from '../../dist/esm/index.js';

test('renders through the ESM package entry', async () => {
  const engine = await createEngine({
    loaders: [memoryLoader({ 'entry.njk': 'ESM {{ value }}' })],
  });
  try {
    assert.equal(
      await engine.render({ name: 'entry.njk' }, { value: 'works' }),
      'ESM works',
    );
  } finally {
    await engine.dispose();
  }
});
