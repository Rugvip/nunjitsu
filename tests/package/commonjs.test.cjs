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
    assert.equal(
      (await Array.fromAsync(
        engine.renderStream({ source: 'stream {{ value }}' }, { value: 'works' }),
      )).join(''),
      'stream works',
    );
  } finally {
    await engine.dispose();
  }
});
