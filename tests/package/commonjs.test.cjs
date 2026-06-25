const assert = require('node:assert/strict');
const test = require('node:test');

const packageExports = require('nunjitsu');
const { createTemplateRenderer } = packageExports;

test('resolves the CommonJS package export', () => {
  assert.match(require.resolve('nunjitsu'), /\/dist\/index\.cjs$/);
  assert.equal(packageExports.createTemplateRenderer, createTemplateRenderer);
  assert.equal(Object.hasOwn(packageExports, 'default'), false);
  assert.equal(Object.hasOwn(packageExports, 'createEngine'), false);
});

test('loads the ESM condition from a CommonJS environment', async () => {
  const module = await import('nunjitsu');
  assert.equal(typeof module.createTemplateRenderer, 'function');
  assert.equal(Object.hasOwn(module, 'default'), false);
  assert.equal(Object.hasOwn(module, 'createEngine'), false);
});

test('renders synchronously through the CommonJS package entry', t => {
  t.mock.method(Math, 'random', () => {
    throw new Error('Math.random must not be called during rendering');
  });
  const engine = createTemplateRenderer({
    filters: {
      'tools.identity'(value) {
        return value;
      },
    },
    globals: {
      value() {
        return 'works';
      },
    },
  });
  assert.equal(
    engine.render('CommonJS ${{ value }}', { value: 'works' }),
    'CommonJS works',
  );
  assert.equal(
    engine.render('global ${{ value() }}'),
    'global works',
  );
  const context = engine.prepareContext({ value: 'prepared' });
  assert.equal(engine.render('CommonJS ${{ value }}', context), 'CommonJS prepared');
  assert.equal(engine.renderValue('${{ value }}', { value: 42 }), 42);
  assert.deepEqual(
    { ...engine.renderValue('${{ value }}', { value: { nested: true } }) },
    { nested: true },
  );
  assert.equal(engine.render('${{ ["only"] | random }}'), 'only');
  assert.equal(engine.render('${{ "dotted" | tools.identity }}'), 'dotted');
  assert.equal(
    engine.render('{% filter tools.identity %}filter block{% endfilter %}'),
    'filter block',
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
