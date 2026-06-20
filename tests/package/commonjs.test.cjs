const assert = require('node:assert/strict');
const test = require('node:test');

const { createEngine } = require('../../dist/cjs/index.cjs');

test('renders through the CommonJS package entry', async () => {
  const engine = await createEngine();
  try {
    assert.equal(
      await engine.render({ source: 'CommonJS {{ value }}' }, { value: 'works' }),
      'CommonJS works',
    );
  } finally {
    await engine.dispose();
  }
});
