import assert from 'node:assert/strict';
import test from 'node:test';

import { createTemplateRenderer } from '../../src/createTemplateRenderer.ts';

test('renders default and Cookiecutter variable modes synchronously', () => {
  const engine = createTemplateRenderer();
  assert.equal(
    engine.render('Hello ${{ values.name }}; {{ untouched }}', {
      values: { name: 'Nunjitsu' },
    }),
    'Hello Nunjitsu; {{ untouched }}',
  );

  const cookiecutter = createTemplateRenderer({ cookiecutterCompat: true });
  assert.equal(
    cookiecutter.render('{{ cookiecutter.name }}:{{ cookiecutter.items | jsonify }}', {
      cookiecutter: { name: 'Nunjitsu', items: [1, 2] },
    }),
    'Nunjitsu:[1,2]',
  );
});

test('invokes synchronous filters and value or function globals through copied data', () => {
  const input = { nested: { value: 'safe' } };
  const engine = createTemplateRenderer({
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
    blocked: {
      undefined: undefined as never,
      nested: { undefined: undefined as never },
      null: null,
      false: false,
      zero: 0,
      string: '',
      array: [],
      record: {},
    },
    stable: 'clean',
  };
  const engine = createTemplateRenderer();
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

  const created = prepared
    .withPath(['created', 'leaf'], 'created')
    .withPath(['blocked', 'record', 'leaf'], 'record');
  assert.equal(
    engine.render('${{ created.leaf }}:${{ blocked.record.leaf }}', created),
    'created:record',
  );

  for (const path of [
    ['blocked', 'undefined', 'leaf'],
    ['blocked', 'nested', 'undefined', 'leaf'],
    ['blocked', 'null', 'leaf'],
    ['blocked', 'false', 'leaf'],
    ['blocked', 'zero', 'leaf'],
    ['blocked', 'string', 'leaf'],
    ['blocked', 'array', 'leaf'],
  ]) {
    assert.throws(() => prepared.withPath(path, 'blocked'), /is not a record/, path.join('.'));
    assert.equal(
      engine.render('${{ stable }}:${{ blocked.undefined is undefined }}', prepared),
      'clean:true',
      path.join('.'),
    );
  }

  const replacedUndefined = prepared.withPath(
    ['blocked', 'undefined'],
    { leaf: 'replacement' },
  );
  assert.equal(
    engine.render('${{ blocked.undefined.leaf }}', replacedUndefined),
    'replacement',
  );
  assert.equal(
    engine.render('${{ stable }}:${{ blocked.undefined is undefined }}', prepared),
    'clean:true',
  );

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
    () => createTemplateRenderer().render('${{ parameters.name }}', prepared),
    /different template renderer/,
  );
});

test('rejects template-loading and extension syntax', () => {
  const engine = createTemplateRenderer();
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
