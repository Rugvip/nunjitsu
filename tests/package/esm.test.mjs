import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { createEngine } from 'nunjitsu';

test('resolves the ESM package export', () => {
  assert.match(import.meta.resolve('nunjitsu'), /\/dist\/esm\/index\.js$/);
});

test('loads the CommonJS condition from an ESM environment', () => {
  const require = createRequire(import.meta.url);
  assert.match(require.resolve('nunjitsu'), /\/dist\/cjs\/index\.cjs$/);
  assert.equal(typeof require('nunjitsu').createEngine, 'function');
});

test('renders synchronously through the ESM package entry', t => {
  t.mock.method(Math, 'random', () => {
    throw new Error('Math.random must not be called during rendering');
  });
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
  const context = engine.prepareContext({ value: 'prepared' });
  assert.equal(engine.render('ESM ${{ value | upper }}', context), 'ESM PREPARED');
  assert.equal(engine.render('${{ ["only"] | random }}'), 'only');
});
