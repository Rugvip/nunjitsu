import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeRenderLimits } from '../../src/limits.ts';
import { evaluateTemplate } from '../../src/runtime/evaluator.ts';

const signal = new AbortController().signal;

test('evaluates closed expressions, scopes, loops, assignments, and escaping', async () => {
  const output = await evaluateTemplate(
    [
      '{% set total = 1 %}',
      '{% for value in values %}',
      '{% set total = total + value %}',
      '{{ loop.index }}={{ value | upper }};',
      '{% endfor %}',
      '{{ total }}|{{ unsafe }}|{{ unsafe | safe }}',
    ].join(''),
    { values: ['a', 'b'], unsafe: '<strong>' },
    {
      autoescape: true,
      trimBlocks: false,
      lstripBlocks: false,
      limits: normalizeRenderLimits(undefined),
      signal,
    },
  );

  assert.equal(output, '1=A;2=B;1ab|&lt;strong&gt;|<strong>');
});

test('evaluates macros, keyword defaults, tests, and call blocks', async () => {
  const output = await evaluateTemplate(
    [
      '{% macro greet(name, suffix="!") %}{{ name | capitalize }}{{ suffix }}{% endmacro %}',
      '{{ greet("alice") }}|{{ greet(name="bob", suffix="?") }}|',
      '{{ missing is undefined }}|{{ 4 is even }}',
    ].join(''),
    {},
    {
      autoescape: true,
      trimBlocks: false,
      lstripBlocks: false,
      limits: normalizeRenderLimits(undefined),
      signal,
    },
  );

  assert.equal(output, 'Alice!|Bob?|true|true');
});

test('never treats looked-up values as JavaScript callables', async () => {
  await assert.rejects(
    evaluateTemplate(
      '{{ value.toString() }}',
      { value: 'secret' },
      {
        autoescape: true,
        trimBlocks: false,
        lstripBlocks: false,
        limits: normalizeRenderLimits(undefined),
        signal,
      },
    ),
    /Unable to call template value/,
  );
});
