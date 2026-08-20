import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createTemplateRenderer,
  TemplateRenderError,
} from '../../src/index.ts';

test('keeps array mutations local to one render while preserving aliases', () => {
  const renderer = createTemplateRenderer();
  const shared = [1];
  const context = { left: shared, right: shared };
  const source = [
    '{% set result=left.push(2) %}',
    '${{ result }}|${{ left|dump }}|${{ right|dump }}',
  ].join('');

  assert.equal(renderer.render(source, context), '2|[1,2]|[1,2]');
  assert.deepEqual(shared, [1]);
  assert.equal(renderer.render(source, context), '2|[1,2]|[1,2]');
  assert.deepEqual(shared, [1]);

  const prepared = renderer.prepareContext(context);
  assert.equal(renderer.render(source, prepared), '2|[1,2]|[1,2]');
  assert.equal(renderer.render(source, prepared), '2|[1,2]|[1,2]');
  assert.deepEqual(shared, [1]);
});

test('preserves sparse array behavior without changing the source array', () => {
  const renderer = createTemplateRenderer();
  const values: string[] = [];
  values.length = 3;
  values[1] = 'middle';
  const source = [
    '${{ values.length }}|${{ values.indexOf(missing) }}|',
    '${{ values.includes(missing) }}|',
    '{% set pushed=values.push("tail") %}${{ pushed }}|${{ values|dump }}|',
    '${{ values.pop() }}|${{ values|dump }}|',
    '${{ values.splice(0,1)|dump }}|${{ values|dump }}|',
    '${{ values.slice(0)|dump }}',
  ].join('');

  assert.equal(
    renderer.render(source, { values }),
    '3|-1|true|4|[null,"middle",null,"tail"]|tail|' +
      '[null,"middle",null]|[null]|["middle",null]|["middle",null]',
  );
  assert.equal(values.length, 3);
  assert.equal(0 in values, false);
  assert.equal(values[1], 'middle');
  assert.equal(2 in values, false);
});

test('discards render-local mutations after success and failure', () => {
  const events: string[] = [];
  const renderer = createTemplateRenderer({
    globals: {
      fail() {
        events.push('fail');
        throw new Error('expected failure');
      },
      later() {
        events.push('later');
        return 'later';
      },
    },
  });
  const values = [1];
  const failingSource = [
    '{% set ignored=values.push(2) %}',
    '${{ fail() }}',
    '${{ later() }}',
  ].join('');

  assert.throws(
    () => renderer.render(failingSource, { values }),
    TemplateRenderError,
  );
  assert.deepEqual(events, ['fail']);
  assert.deepEqual(values, [1]);
  assert.equal(
    renderer.render(
      '{% set ignored=values.push(3) %}${{ values|dump }}',
      { values },
    ),
    '[1,3]',
  );
  assert.deepEqual(values, [1]);
  assert.equal(renderer.render('${{ values|dump }}', { values }), '[1]');
});

test('does not generalize intrinsic dispatch to host prototype or callback methods', () => {
  const events: string[] = [];
  const renderer = createTemplateRenderer({
    globals: {
      mark() {
        events.push('mark');
        return 'marked';
      },
      later() {
        events.push('later');
        return 'later';
      },
    },
  });
  const rejectedSources = [
    '${{ [1].map(mark()) }}${{ later() }}',
    '${{ [1].filter(mark()) }}${{ later() }}',
    '${{ [1].reduce(mark()) }}${{ later() }}',
    '${{ [1].forEach(mark()) }}${{ later() }}',
    '${{ ({value:1}).toString() }}${{ later() }}',
    '${{ ({value:1}).hasOwnProperty("value") }}${{ later() }}',
  ];

  for (const source of rejectedSources) {
    assert.throws(() => renderer.render(source), TemplateRenderError, source);
    assert.deepEqual(events, [], source);
    assert.equal(renderer.render('clean'), 'clean');
  }
});

test('keeps callable authority out of intrinsic arguments and capability values', () => {
  const events: string[] = [];
  const renderer = createTemplateRenderer({
    globals: {
      callback() {
        events.push('callback');
        return 0;
      },
      observe() {
        events.push('observe');
        return 'observed';
      },
      later() {
        events.push('later');
        return 'later';
      },
    },
  });
  const rejectedSources = [
    '${{ [1].push(callback) }}${{ later() }}',
    '${{ [2,1].sort(callback) }}${{ later() }}',
    '${{ "x".replace("x",callback) }}${{ later() }}',
    '${{ observe([1].push) }}${{ later() }}',
    '${{ observe("x".replace) }}${{ later() }}',
  ];

  for (const source of rejectedSources) {
    assert.throws(() => renderer.render(source), TemplateRenderError, source);
    assert.deepEqual(events, [], source);
    assert.equal(renderer.render('clean'), 'clean');
  }
});
