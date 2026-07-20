import assert from 'node:assert/strict';

import {
  createTemplateRenderer,
  TemplateLimitError,
  TemplateRenderError,
  type TemplateContext,
  type TemplateRenderOptions,
  type TemplateRenderer,
  type TemplateRendererOptions,
} from '../src/index.ts';

const maximumSourceCodeUnits = 8_192;
const renderOptions: TemplateRenderOptions = Object.freeze({
  limits: {
    sourceCodeUnits: maximumSourceCodeUnits,
    astNodes: 16_000,
    workUnits: 25_000,
    nestingDepth: 128,
    outputCodeUnits: 32_768,
    scratchBytes: 32_768,
    capabilityCalls: 512,
  },
});
const context: TemplateContext = Object.freeze({
  value: 'clean',
  text: 'hello',
  count: 3,
  flag: true,
  items: [1, 'two', false],
  rows: [
    { key: 'a', value: 1 },
    { key: 'b', value: 2 },
  ],
  object: { key: 'value', nested: { key: 'nested' } },
});
const renderers = Object.freeze([
  createFuzzRenderer({ cookiecutterCompat: false, trimBlocks: false, lstripBlocks: false }),
  createFuzzRenderer({ cookiecutterCompat: false, trimBlocks: true, lstripBlocks: false }),
  createFuzzRenderer({ cookiecutterCompat: false, trimBlocks: false, lstripBlocks: true }),
  createFuzzRenderer({ cookiecutterCompat: false, trimBlocks: true, lstripBlocks: true }),
  createFuzzRenderer({ cookiecutterCompat: true, trimBlocks: false, lstripBlocks: false }),
  createFuzzRenderer({ cookiecutterCompat: true, trimBlocks: true, lstripBlocks: false }),
  createFuzzRenderer({ cookiecutterCompat: true, trimBlocks: false, lstripBlocks: true }),
  createFuzzRenderer({ cookiecutterCompat: true, trimBlocks: true, lstripBlocks: true }),
]);

export function fuzz(data: Buffer): void {
  const selector = data[0] ?? 0;
  const rendererCase = renderers[selector & 7]!;
  const source = data.subarray(1).toString('utf8').slice(0, maximumSourceCodeUnits);

  try {
    if ((selector & 8) === 0) {
      assert.equal(typeof rendererCase.renderer.render(source, context, renderOptions), 'string');
    } else {
      assertPublicValue(rendererCase.renderer.renderValue(source, context, renderOptions));
    }
  } catch (error) {
    assertExpectedRenderFailure(error);
  }

  assert.equal(
    rendererCase.renderer.render(rendererCase.cleanSource, { value: 'clean' }, renderOptions),
    'clean',
  );
}

function createFuzzRenderer(
  options: Required<Pick<TemplateRendererOptions, 'cookiecutterCompat' | 'trimBlocks' | 'lstripBlocks'>>,
): { readonly cleanSource: string; readonly renderer: TemplateRenderer } {
  const renderer = createTemplateRenderer({
    ...options,
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
  return {
    cleanSource: options.cookiecutterCompat ? '{{ value }}' : '${{ value }}',
    renderer,
  };
}

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
