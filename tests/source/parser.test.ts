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
        /Call block|Parenthesized expression cannot be empty/.test(error.message)
      ),
      source,
    );
  }
});

test('lowers filter blocks through immutable filter and capture nodes', () => {
  const ast = parseTemplate(
    '{% filter tools.identity("suffix") %}body{% endfilter %}',
  );
  const filter = findField(ast, value => (
    Boolean(value && typeof value === 'object' && !Array.isArray(value)) &&
    (value as { type?: unknown }).type === 'Filter'
  )) as {
    readonly type?: unknown;
    readonly name?: { readonly value?: unknown };
    readonly args?: { readonly children?: readonly AstNode[] };
  };

  assert.equal(filter.type, 'Filter');
  assert.equal(filter.name?.value, 'tools.identity');
  assert.equal(filter.args?.children?.[0]?.type, 'Capture');
  assert.equal(filter.args?.children?.[1]?.type, 'Literal');
  assertDataOnly(ast);
});

test('preserves non-empty expression groups and rejects empty groups', () => {
  const ast = parseTemplate('${{ (1, 2, 3) }}');
  const group = findField(ast, value => (
    Boolean(value && typeof value === 'object' && !Array.isArray(value)) &&
    (value as { type?: unknown }).type === 'Group'
  )) as { readonly type?: unknown; readonly children?: readonly AstNode[] };
  assert.equal(group.type, 'Group');
  assert.equal(group.children?.length, 3);
  assertDataOnly(ast);

  for (const source of [
    '${{ () }}',
    '{% if false %}${{ () }}{% endif %}',
    '${{ [()] }}',
    '${{ {value: ()} }}',
    '${{ consume(()) }}',
    '${{ "value" | default(()) }}',
    '${{ (()) }}',
  ]) {
    assert.throws(
      () => parseTemplate(source),
      error => (
        error instanceof NunjitsuParseError &&
        /Parenthesized expression cannot be empty/.test(error.message)
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

  const cookiecutter = {
    trimBlocks: false,
    lstripBlocks: false,
    cookiecutterCompat: true,
  };
  for (const flags of ['', 'g', 'i', 'm', 'y', 'gimy']) {
    parseTemplate('${{ r/x/' + flags + ' }}');
    parseTemplate(`{{ r/x/${flags} }}`, cookiecutter);
  }

  for (const [source, message] of [
    ['${{ r/x/s }}', /Unsupported regular-expression flag/],
    ['${{ r/x/u }}', /Unsupported regular-expression flag/],
    ['${{ r/x/d }}', /Unsupported regular-expression flag/],
    ['${{ r/x/v }}', /Unsupported regular-expression flag/],
    ['${{ r/x/gs }}', /Unsupported regular-expression flag/],
    ['${{ r/x/gu }}', /Unsupported regular-expression flag/],
    ['${{ r/x/gd }}', /Unsupported regular-expression flag/],
    ['${{ r/x/gv }}', /Unsupported regular-expression flag/],
    ['${{ r/x/is }}', /Unsupported regular-expression flag/],
    ['${{ r/x/mu }}', /Unsupported regular-expression flag/],
    ['${{ r/x/yd }}', /Unsupported regular-expression flag/],
    ['${{ r/x/a }}', /Unsupported regular-expression flag/],
    ['${{ r/x/G }}', /Unsupported regular-expression flag/],
    ['${{ r/x/gg }}', /Duplicate regular-expression flag/],
    ['${{ r/x/uv }}', /Unsupported regular-expression flag/],
    ['${{ r/' + '\\'.repeat(2) + '/ }}', /Ambiguous regular-expression delimiter escape/],
  ] as const) {
    assert.throws(
      () => parseTemplate(source),
      error => error instanceof NunjitsuParseError && message.test(error.message),
      source,
    );
  }

  for (const source of [
    '${{ r/' + '\\/' + '/ }}',
    '${{ r/' + 'a\\/b' + '/ }}',
    '${{ r/' + 'a' + '\\'.repeat(3) + '/b' + '/ }}',
  ]) {
    parseTemplate(source);
  }

  for (const source of [
    '${{ bar/2 }}',
    '${{ order/2 }}',
    '${{ longerIdentifier/2 }}',
    '${{ obj.bar/2 }}',
    '${{ bar /2 }}',
    '${{ bar//2 }}',
    '${{ bar/2/3 }}',
    '${{ bar/2/s }}',
    '${{ bar/(1 + 1) }}',
  ]) {
    parseTemplate(source);
  }

  parseTemplate('{# ignored r/x/s and r/' + '\\'.repeat(2) + '/ #}');
  parseTemplate('${{ "quoted r/x/s and r/' + '\\'.repeat(2) + '/" }}');

  assert.throws(
    () => parseTemplate('text\n${{ r/' + 'attacker'.repeat(100) + '/s }}'),
    error => (
      error instanceof NunjitsuParseError &&
      error.message === 'Unsupported regular-expression flag' &&
      error.line === 1 &&
      error.column === 4
    ),
  );
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

test('restricts numeric literals to the pinned decimal grammar', () => {
  for (const value of ['0', '00', '01', '1.', '1.0', '00.5', '01.50', '+1.5', '-1.5']) {
    parseTemplate('${{ ' + value + ' }}');
  }

  for (const value of [
    '.5',
    '1e3',
    '1E3',
    '1e+3',
    '1e-3',
    '1.e3',
    '1.0e3',
    '0x10',
    '0Xff',
    '0b10',
    '0o10',
    '1_000',
    '123abc',
  ]) {
    assert.throws(
      () => parseTemplate('${{ ' + value + ' }}'),
      error => (
        error instanceof NunjitsuParseError &&
        error.message === 'Invalid numeric literal'
      ),
      value,
    );
  }
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

test('rejects adjacent identical unary signs while preserving separated forms', () => {
  assert.throws(
    () => parseTemplate('${{ - -value }}'),
    error => (
      error instanceof NunjitsuParseError &&
      error.message === 'Repeated unparenthesized unary - is not supported' &&
      error.line === 0 &&
      error.column === 2
    ),
  );
  const modes = [
    undefined,
    {
      trimBlocks: false,
      lstripBlocks: false,
      cookiecutterCompat: true,
    },
  ];
  const rejectedExpressions = [
    '- -value',
    '--value',
    '-  -  value',
    '+ +value',
    '++value',
    '+  +  value',
    '- + +value',
    '+ - -value',
    '- - + -value',
    'not - -value',
    '1 * + +value',
    '[- -value]',
    '{value: + +value}',
  ];
  const rejectedTemplates = [
    '{% if false %}${{ + +value }}{% endif %}',
    '{% macro f(value=- -value) %}${{ value }}{% endmacro %}',
    '${{ consume(+ +value) }}',
    '${{ "x" | identity(- -value) }}',
  ];
  for (const options of modes) {
    for (const expression of rejectedExpressions) {
      const source = `\${{ ${expression} }}`;
      const renderedSource = options ? source.replaceAll('${{', '{{') : source;
      assert.throws(
        () => parseTemplate(renderedSource, options),
        error => (
          error instanceof NunjitsuParseError &&
          /Repeated unparenthesized unary/.test(error.message)
        ),
        renderedSource,
      );
    }
    for (const source of rejectedTemplates) {
      const renderedSource = options ? source.replaceAll('${{', '{{') : source;
      assert.throws(
        () => parseTemplate(renderedSource, options),
        error => (
          error instanceof NunjitsuParseError &&
          /Repeated unparenthesized unary/.test(error.message)
        ),
        renderedSource,
      );
    }
    for (const expression of [
      '- +value',
      '+ -value',
      '-(-value)',
      '+(+value)',
      'not not value',
    ]) {
      const source = `\${{ ${expression} }}`;
      const renderedSource = options ? source.replaceAll('${{', '{{') : source;
      assert.doesNotThrow(() => parseTemplate(renderedSource, options), renderedSource);
    }
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
