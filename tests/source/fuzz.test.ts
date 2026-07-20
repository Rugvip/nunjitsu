import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';

import {
  createTemplateRenderer,
  TemplateLimitError,
  TemplateRenderError,
  type TemplateContext,
  type TemplateRendererOptions,
  type TemplateValue,
} from '../../src/index.ts';
import { type AstData, isAstNode } from '../../src/parser/ast.ts';
import { NunjitsuParseError, parseTemplate, type ParseOptions } from '../../src/parser/index.ts';

const fuzzProfiles = Object.freeze({
  smoke: {
    dataFragmentCodeUnits: 24,
    expressionCodeUnits: 48,
    sourceCodeUnits: 768,
    templateFragments: 16,
    runs: {
      parser: 300,
      preparedContext: 100,
      render: 200,
    },
  },
  thorough: {
    dataFragmentCodeUnits: 64,
    expressionCodeUnits: 128,
    sourceCodeUnits: 2_048,
    templateFragments: 32,
    runs: {
      parser: 5_000,
      preparedContext: 1_000,
      render: 3_000,
    },
  },
});
const fuzzProfile = process.env.NUNJITSU_FUZZ_PROFILE === 'thorough'
  ? fuzzProfiles.thorough
  : fuzzProfiles.smoke;
const fuzzLimits = Object.freeze({
  sourceCodeUnits: fuzzProfile.sourceCodeUnits,
  astNodes: 2_000,
  workUnits: 3_000,
  nestingDepth: 48,
  outputCodeUnits: 4_096,
  scratchBytes: 4_096,
  capabilityCalls: 96,
});
const identifierArbitrary = fc.constantFrom(
  'value',
  'text',
  'count',
  'flag',
  'items',
  'rows',
  'object',
  'missing',
  'identity',
  'fail',
  'invalid',
  'mark',
  'constructor',
  'prototype',
  '__proto__',
);
const expressionArbitrary = fc.oneof(
  fc.constantFrom(
    'value',
    'text',
    'count',
    'flag',
    'items[0]',
    'rows | length',
    'object.key',
    'missing',
    'true',
    'false',
    'null',
    'undefined',
    '"quoted"',
    '1 + 2 * count',
    'text | identity',
    'fail()',
    'invalid()',
    'mark(value)',
    'r/a+/g',
    '[value, text, count] | dump',
    '{"key": value} | dump',
  ),
  identifierArbitrary,
  fc.string({ maxLength: fuzzProfile.expressionCodeUnits }),
);
const templateFragmentArbitrary = fc.oneof(
  fc.string({ maxLength: fuzzProfile.dataFragmentCodeUnits }),
  expressionArbitrary.map(expression => '${{ ' + expression + ' }}'),
  expressionArbitrary.map(expression => '{{ ' + expression + ' }}'),
  fc.constantFrom(
    '{% if flag %}',
    '{% elif count %}',
    '{% else %}',
    '{% endif %}',
    '{% for item in items %}',
    '{% endfor %}',
    '{% set value = text %}',
    '{% raw %}${{ ignored }}{% endraw %}',
    '{% verbatim %}{{ ignored }}{% endverbatim %}',
    '{# ignored comment #}',
  ),
);
const templateSourceArbitrary = fc
  .array(templateFragmentArbitrary, { maxLength: fuzzProfile.templateFragments })
  .map(parts => parts.join('').slice(0, fuzzLimits.sourceCodeUnits));
const parserOptionsArbitrary: fc.Arbitrary<ParseOptions> = fc.record({
  trimBlocks: fc.boolean(),
  lstripBlocks: fc.boolean(),
  cookiecutterCompat: fc.boolean(),
  astNodes: fc.constant(fuzzLimits.astNodes),
  nestingDepth: fc.constant(fuzzLimits.nestingDepth),
});
const rendererOptionsArbitrary: fc.Arbitrary<TemplateRendererOptions> = fc.record({
  trimBlocks: fc.boolean(),
  lstripBlocks: fc.boolean(),
  cookiecutterCompat: fc.boolean(),
});
const publicKeyArbitrary = fc.constantFrom(
  'value',
  'text',
  'count',
  'flag',
  'items',
  'rows',
  'object',
  'key',
  'nested',
  '0',
  '1',
);
const templateValueArbitrary: fc.Arbitrary<TemplateValue> = fc.letrec(tie => ({
  value: fc.oneof(
    fc.constant(null),
    fc.boolean(),
    fc.integer({ min: -100, max: 100 }),
    fc.string({ maxLength: 32 }),
    fc.array(tie('value') as fc.Arbitrary<TemplateValue>, { maxLength: 4 }),
    fc.dictionary(publicKeyArbitrary, tie('value') as fc.Arbitrary<TemplateValue>, {
      maxKeys: 4,
    }),
  ),
})).value as fc.Arbitrary<TemplateValue>;
const contextArbitrary: fc.Arbitrary<TemplateContext> = fc.record({
  value: templateValueArbitrary,
  text: fc.string({ maxLength: 32 }),
  count: fc.integer({ min: -5, max: 20 }),
  flag: fc.boolean(),
  items: fc.array(templateValueArbitrary, { maxLength: 4 }),
  rows: fc.array(
    fc.record({
      key: fc.string({ maxLength: 8 }),
      value: templateValueArbitrary,
    }),
    { maxLength: 4 },
  ),
  object: fc.dictionary(publicKeyArbitrary, templateValueArbitrary, { maxKeys: 4 }),
});

test('fuzzes parser errors and immutable AST output', () => {
  fc.assert(
    fc.property(templateSourceArbitrary, parserOptionsArbitrary, (source, options) => {
      try {
        assertDataOnly(parseTemplate(source, options));
      } catch (error) {
        if (error instanceof NunjitsuParseError || error instanceof TemplateLimitError) {
          return;
        }
        throw error;
      }
    }),
    { numRuns: fuzzProfile.runs.parser, seed: 0x4e554a },
  );
});

test('fuzzes public render failures and recovery', () => {
  fc.assert(
    fc.property(
      templateSourceArbitrary,
      contextArbitrary,
      rendererOptionsArbitrary,
      fc.boolean(),
      (source, context, rendererOptions, preserveValue) => {
        const renderer = createTemplateRenderer({
          ...rendererOptions,
          filters: {
            identity(value) {
              return value;
            },
            invalid() {
              return new Date() as never;
            },
          },
          globals: {
            fail() {
              throw new Error('expected fuzz failure');
            },
            invalid() {
              return new Date() as never;
            },
            mark(value) {
              return value;
            },
          },
        });

        try {
          if (preserveValue) {
            assertPublicValue(renderer.renderValue(source, context, { limits: fuzzLimits }));
          } else {
            assert.equal(typeof renderer.render(source, context, { limits: fuzzLimits }), 'string');
          }
        } catch (error) {
          assertExpectedRenderFailure(error);
        }

        const cleanSource = rendererOptions.cookiecutterCompat ? '{{ value }}' : '${{ value }}';
        assert.equal(renderer.render(cleanSource, { value: 'clean' }, { limits: fuzzLimits }), 'clean');
      },
    ),
    { numRuns: fuzzProfile.runs.render, seed: 0x515549 },
  );
});

test('fuzzes prepared context updates through the safe value boundary', () => {
  fc.assert(
    fc.property(
      contextArbitrary,
      fc.array(publicKeyArbitrary, { minLength: 1, maxLength: 4 }),
      templateValueArbitrary,
      (context, path, value) => {
        const renderer = createTemplateRenderer();
        const prepared = renderer.prepareContext(context);
        assert.equal(typeof renderer.render('${{ value }}', prepared, { limits: fuzzLimits }), 'string');
        try {
          const updated = prepared.withValue(path, value);
          assert.equal(renderer.render('clean', updated, { limits: fuzzLimits }), 'clean');
        } catch (error) {
          if (!(error instanceof TypeError)) {
            throw error;
          }
        }
        assert.equal(renderer.render('clean', prepared, { limits: fuzzLimits }), 'clean');
        for (const reserved of ['constructor', 'prototype', '__proto__']) {
          assert.throws(
            () => prepared.withValue([reserved], value),
            TypeError,
          );
        }
      },
    ),
    { numRuns: fuzzProfile.runs.preparedContext, seed: 0x545843 },
  );
});

function assertExpectedRenderFailure(error: unknown): void {
  if (error instanceof TemplateLimitError) {
    assert.ok(error.limit);
    return;
  }
  if (error instanceof TemplateRenderError) {
    assert.equal(error.cause, undefined);
    assert.equal(error.message.includes('\n'), false);
    assert.ok(error.message.length <= 1_025);
    return;
  }
  throw error;
}

function assertDataOnly(root: AstData): void {
  const stack = [root];
  while (stack.length > 0) {
    const value = stack.pop();
    if (
      value === undefined ||
      value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      typeof value === 'number'
    ) {
      continue;
    }
    assert.notEqual(typeof value, 'function');
    if (Array.isArray(value)) {
      assert.ok(Object.isFrozen(value));
      stack.push(...value);
      continue;
    }
    if (isAstNode(value)) {
      assert.ok(Object.isFrozen(value));
      for (const child of Object.values(value)) {
        if (child !== value.type && typeof child !== 'number') {
          stack.push(child as AstData);
        }
      }
      continue;
    }
    assert.ok(Object.isFrozen(value));
    assert.deepEqual(Object.keys(value).sort(), ['flags', 'source', 'type']);
  }
}

function assertPublicValue(value: unknown): void {
  const stack = [value];
  while (stack.length > 0) {
    const item = stack.pop();
    if (
      item === undefined ||
      item === null ||
      typeof item === 'string' ||
      typeof item === 'boolean' ||
      typeof item === 'number'
    ) {
      continue;
    }
    if (Array.isArray(item)) {
      assert.ok(Object.isFrozen(item));
      for (let index = 0; index < item.length; index += 1) {
        if (Object.hasOwn(item, index)) {
          stack.push(item[index]);
        }
      }
      continue;
    }
    assert.equal(typeof item, 'object');
    assert.equal(Object.getPrototypeOf(item), null);
    assert.ok(Object.isFrozen(item));
    for (const [key, nested] of Object.entries(item)) {
      assert.notEqual(key, 'constructor');
      assert.notEqual(key, 'prototype');
      assert.notEqual(key, '__proto__');
      stack.push(nested);
    }
  }
}
