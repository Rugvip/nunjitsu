import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createTemplateRenderer,
  TemplateRenderError,
} from '../../src/createTemplateRenderer.ts';
import { TemplateLimitError } from '../../src/limits.ts';

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

test('preserves sole interpolation values and renders every other template as text', () => {
  const sparse: string[] = [];
  sparse.length = 3;
  sparse[1] = 'present';
  const renderer = createTemplateRenderer();
  const context = {
    count: 42,
    enabled: true,
    empty: null,
    text: 'value',
    values: [1, { nested: ['two'] }],
    sparse,
    config: { retries: 3 },
  };

  assert.equal(renderer.renderValue('${{ count }}', context), 42);
  assert.equal(renderer.renderValue('${{ enabled }}', context), true);
  assert.equal(renderer.renderValue('${{ empty }}', context), null);
  assert.equal(renderer.renderValue('${{ text }}', context), 'value');
  assert.equal(renderer.renderValue('${{ missing }}', context), undefined);
  assert.equal(renderer.renderValue('{# before #}${{ count }}{# after #}', context), 42);
  assert.equal(renderer.renderValue('${{ "safe" | safe }}'), 'safe');
  assert.equal(renderer.renderValue('${{ r//yimg }}'), '/(?:)/gimy');

  const values = renderer.renderValue('${{ values }}', context);
  assert.ok(Array.isArray(values));
  assert.notEqual(values, context.values);
  assert.ok(Object.isFrozen(values));
  assert.ok(Object.isFrozen(values[1]));
  assert.ok(Object.isFrozen((values[1] as { nested: readonly string[] }).nested));
  assert.equal(values[0], 1);
  assert.deepEqual((values[1] as { nested: readonly string[] }).nested, ['two']);

  const config = renderer.renderValue('${{ config }}', context);
  assert.notEqual(config, context.config);
  assert.equal(Object.getPrototypeOf(config), null);
  assert.ok(Object.isFrozen(config));
  assert.equal((config as { retries: number }).retries, 3);

  const sparseResult = renderer.renderValue('${{ sparse }}', context);
  assert.ok(Array.isArray(sparseResult));
  assert.equal(sparseResult.length, 3);
  assert.equal(0 in sparseResult, false);
  assert.equal(sparseResult[1], 'present');
  assert.equal(2 in sparseResult, false);

  assert.equal(renderer.renderValue('Count: ${{ count }}', context), 'Count: 42');
  assert.equal(renderer.renderValue('${{ count }}${{ count }}', context), '4242');
  assert.equal(renderer.renderValue(' ${{ count }}', context), ' 42');
  assert.equal(
    renderer.renderValue('{% if enabled %}${{ count }}{% endif %}', context),
    '42',
  );
  assert.equal(
    renderer.renderValue('{% set count = 7 %}${{ count }}', context),
    '7',
  );

  const cookiecutter = createTemplateRenderer({ cookiecutterCompat: true });
  assert.deepEqual(
    cookiecutter.renderValue('{{ config }}', context),
    Object.assign(Object.create(null), { retries: 3 }),
  );
});

test('evaluates renderValue capabilities once and returns frozen public copies', () => {
  let globalCalls = 0;
  let filterCalls = 0;
  const renderer = createTemplateRenderer({
    filters: {
      identity(value) {
        filterCalls += 1;
        return value;
      },
    },
    globals: {
      structured() {
        globalCalls += 1;
        return { values: [1, 2] };
      },
    },
  });

  const result = renderer.renderValue('${{ structured() | identity }}');
  assert.equal(globalCalls, 1);
  assert.equal(filterCalls, 1);
  assert.equal(Object.getPrototypeOf(result), null);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen((result as { values: readonly number[] }).values));
  assert.deepEqual((result as { values: readonly number[] }).values, [1, 2]);
});

test('supports prepared renderValue contexts and preserves their ownership', () => {
  const renderer = createTemplateRenderer();
  const initial = renderer.prepareContext({ value: 1 });
  const updated = initial.withPath(['value'], { nested: true });

  assert.equal(renderer.renderValue('${{ value }}', initial), 1);
  assert.equal(
    (renderer.renderValue('${{ value }}', updated) as { nested: boolean }).nested,
    true,
  );
  assert.throws(
    () => createTemplateRenderer().renderValue('${{ value }}', initial),
    /different template renderer/,
  );
  assert.equal(renderer.renderValue('${{ value }}', initial), 1);
});

test('applies renderValue failures and limits without retaining render state', () => {
  let laterCalls = 0;
  const renderer = createTemplateRenderer({
    globals: {
      privileged() {
        return 'authority';
      },
      fail() {
        throw new Error('capability failed');
      },
      invalid() {
        return new Date() as never;
      },
      later() {
        laterCalls += 1;
        return 'later';
      },
    },
  });

  assert.throws(
    () => renderer.renderValue('${{ later() }}${{ broken( }}'),
    (error: unknown) => error instanceof TemplateRenderError && error.code === 'syntax_error',
  );
  assert.throws(
    () => renderer.renderValue('${{ value.toString() }}${{ later() }}', { value: 'x' }),
    (error: unknown) => error instanceof TemplateRenderError && error.code === 'evaluation_error',
  );
  assert.throws(
    () => renderer.renderValue('${{ fail() }}${{ later() }}'),
    (error: unknown) => error instanceof TemplateRenderError && error.code === 'capability_error',
  );
  assert.throws(
    () => renderer.renderValue('${{ invalid() }}${{ later() }}'),
    (error: unknown) => error instanceof TemplateRenderError && error.code === 'capability_error',
  );
  for (const source of ['${{ privileged }}', '${{ [privileged] }}']) {
    assert.throws(() => renderer.renderValue(source), TemplateRenderError);
  }
  assert.throws(
    () => renderer.renderValue('${{ value }}', { value: 'long' }, {
      limits: { outputCodeUnits: 3 },
    }),
    TemplateLimitError,
  );
  assert.throws(
    () => renderer.renderValue('${{ value }}', { value: [1, 2] }, {
      limits: { outputCodeUnits: 2 },
    }),
    TemplateLimitError,
  );
  assert.deepEqual(
    renderer.renderValue('${{ value }}', { value: [1, 2] }, {
      limits: { outputCodeUnits: 3 },
    }),
    [1, 2],
  );
  const structuredContext = {
    value: Array.from({ length: 100 }, (_, index) => index),
  };
  assert.doesNotThrow(() => renderer.render(
    '${{ value }}',
    structuredContext,
    { limits: { workUnits: 150 } },
  ));
  assert.throws(
    () => renderer.renderValue(
      '${{ value }}',
      structuredContext,
      { limits: { workUnits: 150 } },
    ),
    TemplateLimitError,
  );
  assert.throws(() => renderer.renderValue(1 as never), TypeError);
  assert.throws(
    () => renderer.renderValue('${{ value }}', {}, { limits: { workUnits: -1 } }),
    RangeError,
  );
  assert.equal(laterCalls, 0);
  assert.equal(renderer.renderValue('${{ value }}', { value: 'clean' }), 'clean');
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
