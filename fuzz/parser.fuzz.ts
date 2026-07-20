import assert from 'node:assert/strict';

import { type AstData, isAstNode } from '../src/parser/ast.ts';
import { NunjitsuParseError, parseTemplate } from '../src/parser/index.ts';
import { TemplateLimitError } from '../src/limits.ts';

const maximumSourceCodeUnits = 8_192;

export function fuzz(data: Buffer): void {
  const selector = data[0] ?? 0;
  const source = data.subarray(1).toString('utf8').slice(0, maximumSourceCodeUnits);
  try {
    const ast = parseTemplate(source, {
      trimBlocks: (selector & 1) !== 0,
      lstripBlocks: (selector & 2) !== 0,
      cookiecutterCompat: (selector & 4) !== 0,
      astNodes: 16_000,
      nestingDepth: 128,
    });
    assertDataOnly(ast);
  } catch (error) {
    if (error instanceof NunjitsuParseError || error instanceof TemplateLimitError) {
      return;
    }
    throw error;
  }
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
