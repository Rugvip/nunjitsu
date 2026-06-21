import assert from 'node:assert/strict';
import test from 'node:test';

import { createEngine } from '../../dist/esm/index.js';

test('renders synchronously through the ESM package entry', () => {
  const engine = createEngine({
    filters: {
      upper(input) {
        return String(input).toUpperCase();
      },
    },
  });
  assert.equal(
    engine.render('ESM ${{ value | upper }}', { value: 'works' }),
    'ESM WORKS',
  );
});
