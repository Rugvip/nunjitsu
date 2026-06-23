import assert from 'node:assert/strict';
import test from 'node:test';

import { type AstData, type AstNode, isAstNode } from '../../src/parser/ast.ts';
import { NunjitsuParseError, parseTemplate } from '../../src/parser/index.ts';

test('parses complete templates into deeply immutable data-only nodes', () => {
  const ast = parseTemplate([
    'Hello ${{ user.name | upper }}',
    '{% if enabled %}{% for value in values %}${{ value }}{% endfor %}{% endif %}',
  ].join(''));

  assert.equal(ast.type, 'Root');
  assert.ok(Object.isFrozen(ast));
  assertDataOnly(ast);
});

test('represents call blocks explicitly and rejects effectful targets during parsing', () => {
  for (const source of [
    '{% call wrapper() %}body{% endcall %}',
    '{% call holder.wrapper() %}body{% endcall %}',
    '{% call holder["wrapper"]() %}body{% endcall %}',
  ]) {
    const ast = parseTemplate(source);
    const callBlock = findField(ast, value => (
      Boolean(value && typeof value === 'object' && !Array.isArray(value)) &&
      (value as { type?: unknown }).type === 'CallBlock'
    )) as { readonly type?: unknown; readonly call?: unknown; readonly caller?: unknown };
    assert.equal(callBlock.type, 'CallBlock');
    assert.ok(callBlock.call);
    assert.ok(callBlock.caller);
  }

  for (const source of [
    '{% call factory()() %}body{% endcall %}',
    '{% call holder[key()]() %}body{% endcall %}',
    '{% call (wrapper | default(fallback))() %}body{% endcall %}',
  ]) {
    assert.throws(
      () => parseTemplate(source),
      error => (
        error instanceof NunjitsuParseError &&
        /Call block/.test(error.message)
      ),
      source,
    );
  }
});

test('rejects reserved names in every expression form', () => {
  for (const source of [
    '${{ constructor }}',
    '${{ value.constructor }}',
    '${{ value["prototype"] }}',
    '{% set __proto__ = 1 %}',
    '${{ {"constructor": 1} }}',
  ]) {
    assert.throws(
      () => parseTemplate(source),
      error => error instanceof NunjitsuParseError && /reserved/.test(error.message),
    );
  }
});

test('validates inactive branches and stores regexes as inert data', () => {
  assert.throws(
    () => parseTemplate('{% if false %}${{ broken( }}{% endif %}'),
    error => error instanceof NunjitsuParseError,
  );

  const ast = parseTemplate('${{ r/a+b/gi }}');
  const regex = findField(ast, value => (
    Boolean(value && typeof value === 'object' && !Array.isArray(value)) &&
    (value as { type?: unknown }).type === 'regex-literal'
  ));
  assert.deepEqual(regex, { type: 'regex-literal', source: 'a+b', flags: 'gi' });
  assert.ok(Object.isFrozen(regex));
});

test('applies whitespace controls and supports explicit Cookiecutter mode', () => {
  const ast = parseTemplate('a{% if true %}\n b{% endif %}', {
    trimBlocks: true,
    lstripBlocks: false,
  });
  const text = findField(ast, value => value === ' b');
  assert.equal(text, ' b');

  assert.equal(
    findField(parseTemplate('{{ value }}'), value => value === '{{ value }}'),
    '{{ value }}',
  );
  const cookiecutter = parseTemplate('{{ values[1:3] | dump }}', {
    trimBlocks: false,
    lstripBlocks: false,
    cookiecutterCompat: true,
  });
  assert.equal(cookiecutter.type, 'Root');
});

test('scans delimiters only outside literals and rejects malformed complete input', () => {
  const cookiecutter = {
    trimBlocks: false,
    lstripBlocks: false,
    cookiecutterCompat: true,
  };
  assert.equal(
    findField(parseTemplate('{{ "}}" }}', cookiecutter), value => value === '}}'),
    '}}',
  );
  assert.equal(
    findField(
      parseTemplate('{% if "%}" == "%}" %}ok{% endif %}', cookiecutter),
      value => value === 'ok',
    ),
    'ok',
  );
  assert.equal(
    findField(
      parseTemplate('{% raw %}{{ untouched }}{% endraw %}', cookiecutter),
      value => value === '{{ untouched }}',
    ),
    '{{ untouched }}',
  );

  for (const source of [
    '{{',
    '{{ value( }}',
    '{% if true %}',
    '{% for value values %}{% endfor %}',
    '{% raw %}',
    '{% endfor %}',
  ]) {
    assert.throws(() => parseTemplate(source, cookiecutter), NunjitsuParseError, source);
  }
});

test('rejects template loading syntax during complete parsing', () => {
  for (const source of [
    '{% include "x" %}',
    '{% import "x" as x %}',
    '{% from "x" import y %}',
    '{% extends "x" %}',
  ]) {
    assert.throws(() => parseTemplate(source), /Unsupported template-loading tag/);
  }
});

function assertDataOnly(value: AstData): void {
  if (
    value === undefined ||
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  ) {
    return;
  }
  assert.notEqual(typeof value, 'function');
  if (Array.isArray(value)) {
    assert.ok(Object.isFrozen(value));
    value.forEach(assertDataOnly);
    return;
  }
  if (isAstNode(value)) {
    assert.ok(Object.isFrozen(value));
    for (const child of Object.values(value)) {
      if (child !== value.type && typeof child !== 'number') {
        assertDataOnly(child as AstData);
      }
    }
    return;
  }
  assert.deepEqual(Object.keys(value).sort(), ['flags', 'source', 'type']);
}

function findField(node: AstNode, predicate: (value: AstData) => boolean): AstData {
  for (const value of Object.values(node) as AstData[]) {
    if (predicate(value)) {
      return value;
    }
    if (isAstNode(value)) {
      const nested = findField(value, predicate);
      if (nested !== undefined) {
        return nested;
      }
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (predicate(item)) {
          return item;
        }
        if (isAstNode(item)) {
          const nested = findField(item, predicate);
          if (nested !== undefined) {
            return nested;
          }
        }
      }
    }
  }
  return undefined;
}
