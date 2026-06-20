import assert from 'node:assert/strict';
import test from 'node:test';

import { createEngine, NunjitsuRenderError } from '../../src/index.ts';

test('renders through reusable shared-memory workers', async () => {
  const engine = await createEngine({
    workerPool: { minWorkers: 1, maxWorkers: 2 },
  });

  try {
    const [greeting, staticText, missingValue] = await Promise.all([
      engine.render({ source: 'Hello {{ name }}!' }, { name: 'Nunjitsu' }),
      engine.render({ source: 'No interpolation' }),
      engine.render({ source: 'Missing: {{ value }}.' }),
    ]);
    assert.equal(greeting, 'Hello Nunjitsu!');
    assert.equal(staticText, 'No interpolation');
    assert.equal(missingValue, 'Missing: .');

    const stream = engine.renderStream({ source: '{{ value }}' }, { value: 'streamed' });
    assert.equal((await Array.fromAsync(stream)).join(''), 'streamed');

    await assert.rejects(
      engine.render({ source: '{{ unclosed' }),
      (error: unknown) => error instanceof NunjitsuRenderError && error.code === 3,
    );

    assert.equal(
      await engine.render({ source: 'Clean after failure: {{ ok }}' }, { ok: 'yes' }),
      'Clean after failure: yes',
    );
  } finally {
    await engine.dispose();
  }

  await assert.rejects(engine.render({ source: 'disposed' }), /disposed/);
});
