const assert = require('node:assert/strict');
const test = require('node:test');

const { createEngine } = require('../../dist/cjs/index.cjs');

test('renders synchronously through the CommonJS package entry', () => {
  const engine = createEngine({
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
});
