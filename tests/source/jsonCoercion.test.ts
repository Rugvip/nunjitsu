import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import nunjucks from 'nunjucks';

import {
  createTemplateRenderer,
  TemplateLimitError,
  TemplateRenderError,
  type TemplateValue,
} from '../../src/index.ts';

// Backstage's value wrapper before migration commit 943687f3db8c. Nunjucks is
// deliberately only an oracle; the runtime must not reproduce its regex rewrite.
function legacyValue(source: string): unknown {
  const { parser, nodes } = nunjucks as unknown as {
    parser: { parse(source: string, context: object, options: object): {
      children: { children?: unknown[] }[];
    } };
    nodes: { TemplateData: new (...args: never[]) => object };
  };
  const options = { autoescape: false, tags: { variableStart: '${{', variableEnd: '}}' } };
  const environment = new nunjucks.Environment(null, options);
  const parsed = parser.parse(source, {}, options);
  if (parsed.children.length === 1 &&
      !(parsed.children[0]?.children?.[0] instanceof nodes.TemplateData)) {
    try {
      const output = environment.renderString(source.replace(/\$\{\{(.+)\}\}/g, '${{ ( $1 ) | dump }}'), {});
      return output === '' ? undefined : JSON.parse(output);
    } catch {
      // The historical wrapper falls back to the original source.
    }
  }
  const output = environment.renderString(source, {});
  return output === '' ? undefined : output;
}

test('JSON value coercion matches legacy Scaffolder shapes while defaults stay unchanged', () => {
  const cases: readonly [string, TemplateValue | undefined][] = [
    ['{% if true %}false{% endif %}', false],
    ['{% if true %}${{ false }}{% endif %}', false],
    ['{% if true %}${{ [1, 2] }}{% endif %}', [1, 2]],
    ['{% if true %}${{ {answer: 42} }}{% endif %}', { answer: 42 }],
    ['{% if true %}${{ "1" }}{% endif %}', '1'],
    ['{# comment #}{% if true %}false{% endif %}', false],
    ['{% if true %}{# {% if fake %} #}false{% endif %}', false],
    [' {% if true %}false{% endif %} ', ' false '],
    ['{% raw %}false{% endraw %}', 'false'],
    ['{% if true %}1{% endif %}{% if true %}2{% endif %}', '12'],
    ['{% if true %}{% if true %}7{% endif %}{% endif %}', 7],
    ['{% if false %}x{% endif %}', undefined],
    ['{% set x %}{% set y = 1 %}{% endset %}', undefined],
    ['', undefined],
    ['{# comment #}', undefined],
    ['${{ "" }}', ''],
    ['${{ missing }}', undefined],
    ['{% if true %}${{ missing }}{% endif %}', undefined],
    ['{% if true %}null{% endif %}', null],
    ['{% if true %}1.10{% endif %}', 1.1],
    ['{% if true %}007{% endif %}', '007'],
    ['{% for x in [1,2] %}${{ x }}{% endfor %}', 12],
    ['{% if true %}hello ${{ "world" }}!{% endif %}', 'hello world!'],
    ['hello ${{ "world" }}!', 'hello world!'],
    ['{% if true %}${{\n false\n}}{% endif %}', false],
    ['${{ 1 }}${{ 2 }}', '12'],
    ['${{ "1" }}${{ "2" }}', '12'],
    ['${{ "1" }}', '1'],
    ['false', 'false'],
  ];
  const renderer = createTemplateRenderer();
  for (const [source, expected] of cases) {
    assert.equal(JSON.stringify(legacyValue(source)), JSON.stringify(expected), `oracle: ${source}`);
    for (const cookiecutterCompat of [false, true]) {
      const engine = cookiecutterCompat ? createTemplateRenderer({ cookiecutterCompat }) : renderer;
      const template = cookiecutterCompat ? source.replaceAll('${{', '{{') : source;
      assert.equal(
        JSON.stringify(engine.renderValue(template, {}, { coercion: 'json' })),
        JSON.stringify(expected), template,
      );
      const normal = engine.render(template);
      assert.deepEqual(engine.renderValue(template, {}, { coercion: 'none' }), engine.renderValue(template));
      if (!source.startsWith('${{') || source === '${{ 1 }}${{ 2 }}' || source === '${{ "1" }}${{ "2" }}') {
        assert.equal(engine.renderValue(template), normal, `default: ${template}`);
      }
      assert.equal(engine.render(template, {}, { coercion: 'json' } as never), normal);
    }
  }
});

test('encodes final interpolations, preserving capture, macro and filter semantics', () => {
  const cases: readonly [string, TemplateValue | undefined, unknown][] = [
    ['{% if true %}{% set x %}${{ "1" }}{% endset %}${{ x }}{% endif %}', '1', '1'],
    ['{% if true %}{% set x %}${{ "1" }}{% endset -%}\n${{ x }}{% endif %}', '1', '"1"'],
    ['{% if true %}{% macro x() %}${{ "1" }}{% endmacro %}${{ x() }}{% endif %}', '1', '1'],
    ['{% filter upper %}${{ "word" }}{% endfilter %}', 'WORD', 'WORD'],
    [' \n{%- if true -%}${{- false -}}{%- endif -%}\n ', false, 'false'],
    ['{% if true %}${{ 1 }}${{ 2 }}{% endif %}', 12, '12'],
    ['{% if true %}${{ "1" }}${{ "2" }}{% endif %}', '12', '12'],
    ['{% if true %}${{ "1" ~\n "2" }}{% endif %}', '12', 12],
  ];
  const renderer = createTemplateRenderer();
  for (const [source, expected, historical] of cases) {
    assert.equal(legacyValue(source), historical, source);
    assert.equal(renderer.renderValue(source, {}, { coercion: 'json' }), expected, source);
  }
});

test('falls back without repeating capabilities or mutations and exports safe detached JSON', () => {
  let calls = 0;
  const renderer = createTemplateRenderer({
    filters: { dump() { throw new Error('implicit encoding must not use the registry'); } },
    globals: { value() { calls += 1; return 'world'; } },
  });
  const prepared = renderer.prepareContext({ items: [1], config: { nested: [2] } });
  assert.equal(renderer.renderValue('{% if true %}hello ${{ value() }}!{% endif %}', prepared, { coercion: 'json' }), 'hello world!');
  assert.equal(calls, 1);
  assert.equal(renderer.renderValue('{% if true %}${{ items.push(2) }}x${{ items }}{% endif %}', prepared, { coercion: 'json' }), '2x1,2');
  assert.deepEqual(renderer.renderValue('${{ items }}', prepared), [1]);
  const result = renderer.renderValue('{% if true %}${{ config }}{% endif %}', prepared, { coercion: 'json' }) as { nested: number[] };
  assert.equal(Object.getPrototypeOf(result), null);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.nested));
  assert.deepEqual(result.nested, [2]);
  assert.notEqual(result, renderer.renderValue('${{ config }}', prepared));
  assert.equal(renderer.renderValue('${{ value() }}', prepared, { coercion: 'json' }), 'world');
  assert.equal(calls, 2);
  assert.throws(() => renderer.renderValue('text', {}, { coercion: 'other' } as never), TypeError);
});

test('JSON mode preserves complete validation, limits, callable rejection and fail-stop errors', () => {
  let laterCalls = 0;
  const renderer = createTemplateRenderer({ globals: {
    later() { laterCalls += 1; return 'later'; },
    fail() { throw new Error('failed'); },
    invalid() { return new Date() as never; },
  } });
  const failures: readonly [string, string][] = [
    ['{% if true %}${{ later() }}{% endif %}${{ broken( }}', 'syntax_error'],
    ['{% if false %}${{ broken( }}{% endif %}', 'syntax_error'],
    ['{% if true %}${{ fail() }}${{ later() }}{% endif %}', 'capability_error'],
    ['{% if true %}${{ invalid() }}${{ later() }}{% endif %}', 'capability_error'],
    ['{% if true %}${{ [later] }}${{ later() }}{% endif %}', 'evaluation_error'],
    ['{% if true %}${{ "x".toString() }}${{ later() }}{% endif %}', 'evaluation_error'],
    ['{% if true %}{"__proto__":1}{% endif %}', 'evaluation_error'],
  ];
  for (const [source, code] of failures) {
    assert.throws(() => renderer.renderValue(source, {}, { coercion: 'json' }), error => (
      error instanceof TemplateRenderError && error.code === code &&
      error.cause === undefined && error.line !== undefined
    ));
    assert.equal(laterCalls, 0);
    assert.equal(renderer.renderValue('${{ "clean" }}', {}, { coercion: 'json' }), 'clean');
  }
  for (const limits of [
    { sourceCodeUnits: 1 }, { astNodes: 1 }, { workUnits: 1 },
    { nestingDepth: 1 }, { outputCodeUnits: 1 }, { scratchBytes: 1 },
    { capabilityCalls: 0 },
  ]) {
    assert.throws(() => renderer.renderValue('${{ later() }}', {}, { coercion: 'json', limits }), TemplateLimitError);
    assert.equal(renderer.renderValue('clean', {}, { coercion: 'json' }), 'clean');
  }
  assert.throws(() => renderer.renderValue('{% if true %}${{ values }}{% endif %}', { values: Array(100).fill(1) }, {
    coercion: 'json', limits: { workUnits: 150 },
  }), TemplateLimitError);
  assert.equal(renderer.renderValue('clean', {}, { coercion: 'json' }), 'clean');
});

test('clears legacy RegExp state for coercion API failures and reads the mode once', () => {
  const renderer = createTemplateRenderer();
  const getterFailure = new Error('getter failed');
  for (const options of [
    { coercion: 'invalid' } as never,
    { get coercion(): never { throw getterFailure; } },
  ]) {
    /(sensitive)/.exec('sensitive');
    assert.throws(() => renderer.renderValue('x', {}, options));
    assert.equal(RegExp.$1, '');
    assert.equal(renderer.renderValue('${{ 1 }}', {}, { coercion: 'json' }), 1);
  }
  let reads = 0;
  assert.equal(renderer.renderValue('${{ 1 }}', {}, {
    get coercion() { reads += 1; return 'json' as const; },
  }), 1);
  assert.equal(reads, 1);
});

test('recognizes JSON syntax failures across realms without swallowing other errors', t => {
  const foreignParse = runInNewContext('JSON.parse') as typeof JSON.parse;
  assert.throws(() => foreignParse('invalid'), error => (
    error instanceof Error === false &&
    (error as Error).name === 'SyntaxError'
  ));
  const renderer = createTemplateRenderer();
  const parse = t.mock.method(JSON, 'parse', foreignParse);
  assert.equal(renderer.renderValue('{% if true %}not JSON{% endif %}', {}, { coercion: 'json' }), 'not JSON');
  assert.equal(renderer.renderValue('{% if true %}false{% endif %}', {}, { coercion: 'json' }), false);
  for (const error of [
    runInNewContext('new RangeError("failed")') as Error,
    { name: 'SyntaxError' },
    new TemplateLimitError('workUnits'),
  ]) {
    parse.mock.mockImplementation(() => { throw error; });
    assert.throws(() => renderer.renderValue('{% if true %}false{% endif %}', {}, { coercion: 'json' }),
      error instanceof TemplateLimitError ? TemplateLimitError : TemplateRenderError);
    parse.mock.mockImplementation(foreignParse);
    assert.equal(renderer.renderValue('{% if true %}true{% endif %}', {}, { coercion: 'json' }), true);
  }
});
