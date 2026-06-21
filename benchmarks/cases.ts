import type { TemplateContext } from '../src/index.ts';

/** Stable identifier accepted by the benchmark CLI. */
export type BenchmarkCaseId = 'template-files' | 'expressions';

/** Equivalent sources and data rendered by both implementations. */
export interface BenchmarkWorkload {
  /** Stable command-line identifier. */
  id: BenchmarkCaseId;
  /** Human-readable stress profile. */
  description: string;
  /** Inline files rendered independently during one measured operation. */
  sources: readonly string[];
  /** Copied input shared by both implementations. */
  context: TemplateContext;
}

function createTemplateFilesWorkload(): BenchmarkWorkload {
  const fileCount = 50;
  const groups = Array.from({ length: fileCount }, (_, file) =>
    Array.from({ length: 10 }, (_, item) => ({
      name: `item-${file}-${item}`,
      value: file * 10 + item,
      visible: item % 3 !== 0,
    })),
  );
  const sources = Array.from({ length: fileCount }, (_, file) => [
    `{# file ${file}: ${'parser-only-comment '.repeat(12)} #}`,
    '{% macro label(value) %}[${{ value | upper }}]{% endmacro %}',
    `<section id="file-${file}">`,
    `{% set heading = "Section ${file}" %}`,
    '<h2>${{ heading }}</h2>',
    `{% for item in groups[${file}] %}`,
    `  {# ${'dense comment '.repeat(10)} #}`,
    '  {% if item.visible %}<p>${{ loop.index }}:${{ label(item.name) }}=${{ item.value }}</p>{% endif %}',
    '{% endfor %}',
    '<footer>${{ title | upper }}</footer>',
    '</section>',
  ].join('\n'));

  return {
    id: 'template-files',
    description: `${fileCount} independently parsed files with macros, loops, branches, and dense comments`,
    sources,
    context: { title: 'Benchmark', groups },
  };
}

function createExpressionWorkload(): BenchmarkWorkload {
  const items = Array.from({ length: 750 }, (_, index) => ({
    name: `row-${index}`,
    base: index + 11,
    offset: (index * 17) % 31,
    divisor: index % 9 + 1,
    factor: index % 13 + 3,
    enabled: index % 5 !== 0,
    kind: ['alpha', 'beta', 'gamma', 'delta'][index % 4]!,
  }));
  const source = [
    '{% for item in items %}',
    '  {% set first = item.base * 7 + item.offset %}',
    '  {% set second = (first // item.divisor) % 97 %}',
    '  {% set third = (second ** 2 + item.factor * 13) % 997 %}',
    '  {% set selected = (third >= 500 and item.enabled) or third == 42 %}',
    '  {% if selected and item.kind in ["alpha", "gamma"] %}H{% else %}L{% endif %}',
    '${{ loop.index0 }}:${{ first }}:${{ second }}:${{ third }}:',
    '${{ item.name ~ ":" ~ (first + second + third) }}\n',
    '{% endfor %}',
  ].join('');

  return {
    id: 'expressions',
    description: `${items.length} loop iterations with arithmetic, powers, comparisons, membership, and concatenation`,
    sources: [source],
    context: { items },
  };
}

/** Significant output-equivalent synchronous workloads. */
export const benchmarkWorkloads: readonly BenchmarkWorkload[] = Object.freeze([
  createTemplateFilesWorkload(),
  createExpressionWorkload(),
]);
