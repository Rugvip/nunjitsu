import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import * as packageExports from 'nunjitsu';
import { createTemplateRenderer } from 'nunjitsu';

test('resolves the ESM package export', () => {
  assert.match(import.meta.resolve('nunjitsu'), /\/dist\/esm\/index\.js$/);
  assert.equal(packageExports.createTemplateRenderer, createTemplateRenderer);
  assert.equal(Object.hasOwn(packageExports, 'default'), false);
  assert.equal(Object.hasOwn(packageExports, 'createEngine'), false);
});

test('loads the CommonJS condition from an ESM environment', () => {
  const require = createRequire(import.meta.url);
  assert.match(require.resolve('nunjitsu'), /\/dist\/cjs\/index\.cjs$/);
  const commonJsExports = require('nunjitsu');
  assert.equal(typeof commonJsExports.createTemplateRenderer, 'function');
  assert.equal(Object.hasOwn(commonJsExports, 'default'), false);
  assert.equal(Object.hasOwn(commonJsExports, 'createEngine'), false);
});

test('renders synchronously through the ESM package entry', t => {
  t.mock.method(Math, 'random', () => {
    throw new Error('Math.random must not be called during rendering');
  });
  const engine = createTemplateRenderer({
    filters: {
      upper(input) {
        return String(input).toUpperCase();
      },
      'tools.identity'(input) {
        return input;
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
  assert.equal(engine.render('${{ "dotted" | tools.identity }}'), 'dotted');
  assert.equal(
    engine.render('{% filter upper %}filter block{% endfilter %}'),
    'FILTER BLOCK',
  );
  assert.throws(
    () => engine.render('${{ value["LEFT\\u061cARABIC\\u200eLTR\\u200fRTL"]() }}', {
      value: {},
    }),
    error => (
      !error.message.includes('\u061c') &&
      !error.message.includes('\u200e') &&
      !error.message.includes('\u200f')
    ),
  );
});
