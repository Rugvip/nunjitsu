import assert from 'node:assert/strict';
import test from 'node:test';

import { createNativeEngine } from '../../src/native-engine.ts';

test('renders Backstage and Cookiecutter variable modes synchronously', () => {
  const backstage = createNativeEngine();
  assert.equal(
    backstage.render('Hello ${{ values.name }}; {{ untouched }}', {
      values: { name: 'Nunjitsu' },
    }),
    'Hello Nunjitsu; {{ untouched }}',
  );

  const cookiecutter = createNativeEngine({ cookiecutterCompat: true });
  assert.equal(
    cookiecutter.render('{{ cookiecutter.name }}:{{ cookiecutter.items | jsonify }}', {
      cookiecutter: { name: 'Nunjitsu', items: [1, 2] },
    }),
    'Nunjitsu:[1,2]',
  );
});

test('invokes synchronous filters and value or function globals through copied data', () => {
  const input = { nested: { value: 'safe' } };
  const engine = createNativeEngine({
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

test('rejects template-loading and extension syntax', () => {
  const engine = createNativeEngine();
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
