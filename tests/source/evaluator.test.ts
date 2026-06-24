import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeRenderLimits } from '../../src/limits.ts';
import { evaluateTemplate } from '../../src/runtime/evaluator.ts';

const options = {
  cookiecutterCompat: false,
  trimBlocks: false,
  lstripBlocks: false,
  limits: normalizeRenderLimits(undefined),
};

test('evaluates closed expressions, scopes, loops, and assignments synchronously', () => {
  const output = evaluateTemplate(
    [
      '{% set total = 1 %}',
      '{% for value in values %}',
      '{% set total = total + value %}',
      '${{ loop.index }}=${{ value | upper }};',
      '{% endfor %}',
      '${{ total }}|${{ unsafe }}|${{ unsafe | escape }}',
    ].join(''),
    { values: ['a', 'b'], unsafe: '<strong>' },
    options,
  );

  assert.equal(output, '1=A;2=B;1ab|<strong>|&lt;strong&gt;');
});

test('evaluates macros, keyword defaults, tests, and call blocks', () => {
  const output = evaluateTemplate(
    [
      '{% macro greet(name, suffix="!") %}${{ name | capitalize }}${{ suffix }}{% endmacro %}',
      '${{ greet("alice") }}|${{ greet(name="bob", suffix="?") }}|',
      '${{ missing is undefined }}|${{ 4 is even }}',
    ].join(''),
    {},
    options,
  );

  assert.equal(output, 'Alice!|Bob?|true|true');
});

test('never treats looked-up values as JavaScript callables', () => {
  assert.throws(
    () => evaluateTemplate('${{ value.toString() }}', { value: 'secret' }, options),
    /Template value "value\.toString" resolved to undefined and cannot be called/,
  );
});
