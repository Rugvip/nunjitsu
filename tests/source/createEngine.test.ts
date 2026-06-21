import assert from 'node:assert/strict';
import test from 'node:test';

import { createEngine } from '../../src/createEngine.ts';

test('renders default and Cookiecutter variable modes synchronously', () => {
  const engine = createEngine();
  assert.equal(
    engine.render('Hello ${{ values.name }}; {{ untouched }}', {
      values: { name: 'Nunjitsu' },
    }),
    'Hello Nunjitsu; {{ untouched }}',
  );

  const cookiecutter = createEngine({ cookiecutterCompat: true });
  assert.equal(
    cookiecutter.render('{{ cookiecutter.name }}:{{ cookiecutter.items | jsonify }}', {
      cookiecutter: { name: 'Nunjitsu', items: [1, 2] },
    }),
    'Nunjitsu:[1,2]',
  );
});

test('invokes synchronous filters and value or function globals through copied data', () => {
  const input = { nested: { value: 'safe' } };
  const engine = createEngine({
    filters: {
      inspect(value, suffix) {
        assert.equal(Object.getPrototypeOf(value), null);
        assert.ok(Object.isFrozen(value));
        return `${(value as { nested: { value: string } }).nested.value}-${suffix}`;
      },
    },
    globals: {
      answer: 42,
      greeting(name) {
        return `hello ${name}`;
      },
    },
  });

  assert.equal(
    engine.render(
      '${{ input | inspect("suffix") }}=${{ answer }}:${{ greeting("world") }}',
      { input },
    ),
    'safe-suffix=42:hello world',
  );
});

test('reuses immutable prepared contexts and derives structurally shared updates', () => {
  const input = {
    parameters: { name: 'initial' },
    steps: { first: { output: { value: 1 } } },
  };
  const engine = createEngine();
  const prepared = engine.prepareContext(input);

  input.parameters.name = 'mutated';
  input.steps.first.output.value = 99;
  assert.equal(
    engine.render('${{ parameters.name }}:${{ steps.first.output.value }}', prepared),
    'initial:1',
  );

  const secondOutput = { value: 2 };
  const updated = prepared.withPath(['steps', 'second', 'output'], secondOutput);
  secondOutput.value = 3;
  assert.equal(engine.render('${{ steps.second.output.value }}', prepared), '');
  assert.equal(
    engine.render('${{ steps.first.output.value }}:${{ steps.second.output.value }}', updated),
    '1:2',
  );

  assert.equal(
    engine.render('{% set parameters = "local" %}${{ parameters }}', prepared),
    'local',
  );
  assert.equal(engine.render('${{ parameters.name }}', prepared), 'initial');
  assert.ok(Object.isFrozen(prepared));
  assert.ok(Object.isFrozen(updated));

  assert.throws(
    () => prepared.withPath(['parameters', 'name', 'nested'], 'blocked'),
    /is not a record/,
  );
  assert.throws(() => prepared.withPath([], 'blocked'), /non-empty array/);
  assert.throws(
    () => prepared.withPath(['steps', 1 as never], 'blocked'),
    /only strings/,
  );
  assert.throws(
    () => createEngine().render('${{ parameters.name }}', prepared),
    /different engine/,
  );
});

test('rejects template-loading and extension syntax', () => {
  const engine = createEngine();
  for (const source of [
    '{% include "partial.njk" %}',
    '{% import "macros.njk" as macros %}',
    '{% from "macros.njk" import value %}',
    '{% extends "base.njk" %}',
    '{% asyncEach value in values %}${{ value }}{% endeach %}',
    '{% asyncAll value in values %}${{ value }}{% endall %}',
    '{% unknown %}',
  ]) {
    assert.throws(() => engine.render(source));
  }
});
