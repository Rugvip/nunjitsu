import assert from 'node:assert/strict';
import test from 'node:test';

import { createEngine } from '../../dist/esm/index.js';

test('renders through the ESM package entry', async () => {
  const engine = await createEngine();
  try {
    assert.equal(
      await engine.render({ source: 'ESM {{ value }}' }, { value: 'works' }),
      'ESM works',
    );
  } finally {
    await engine.dispose();
  }
});
