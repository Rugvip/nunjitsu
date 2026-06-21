import type { TemplateContext } from '../src/index.ts';

/** Stable identifier accepted by the benchmark CLI. */
export type BenchmarkCaseId =
  | 'template-files'
  | 'expressions'
  | 'tiny-templates'
  | 'deep-lookups'
  | 'macros-scopes'
  | 'filter-pipelines'
  | 'evolving-context';

/** Equivalent sources and data rendered by both implementations. */
export interface StaticBenchmarkWorkload {
  /** Selects the ordinary repeated rendering lifecycle. */
  readonly kind: 'static';
  /** Stable command-line identifier. */
  id: Exclude<BenchmarkCaseId, 'evolving-context'>;
  /** Human-readable stress profile. */
  description: string;
  /** Inline files rendered independently during one measured operation. */
  sources: readonly string[];
  /** Copied input shared by both implementations. */
  context: TemplateContext;
}

/** One output value applied before an evolving-context render. */
export type EvolvingContextUpdate = Readonly<{
  /** Monotonic value visible through the current step output. */
  sequence: number;
  /** Status rendered alongside the sequence. */
  status: string;
  /** Nested data proving the complete output record was replaced. */
  payload: Readonly<{ value: string }>;
}>;

/** Repeated rendering while an engine-owned prepared context evolves. */
export interface EvolvingContextBenchmarkWorkload {
  /** Selects the prepared-context update lifecycle. */
  readonly kind: 'evolving-context';
  /** Stable command-line identifier. */
  readonly id: 'evolving-context';
  /** Human-readable stress profile. */
  readonly description: string;
  /** Simple inline source rendered after every update. */
  readonly source: string;
  /** Initial public data prepared during benchmark setup. */
  readonly context: TemplateContext;
  /** Complete output records applied sequentially during each operation. */
  readonly updates: readonly EvolvingContextUpdate[];
}

/** One benchmark lifecycle understood by both comparison engines. */
export type BenchmarkWorkload = StaticBenchmarkWorkload | EvolvingContextBenchmarkWorkload;

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
    kind: 'static',
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
    kind: 'static',
    id: 'expressions',
    description: `${items.length} loop iterations with arithmetic, powers, comparisons, membership, and concatenation`,
    sources: [source],
    context: { items },
  };
}

function createTinyTemplatesWorkload(): BenchmarkWorkload {
  const values = Array.from({ length: 32 }, (_, index) => ({
    name: `value-${index}`,
    enabled: index % 3 !== 0,
  }));
  const sources = Array.from({ length: 500 }, (_, index) => [
    `entry-${index}:`,
    `\${{ values[${index % values.length}].name }}`,
    `:\${{ values[${index % values.length}].enabled }}`,
    '\n',
  ].join(''));
  return {
    kind: 'static',
    id: 'tiny-templates',
    description: `${sources.length} distinct tiny templates measuring fixed one-shot render overhead`,
    sources,
    context: { values },
  };
}

function createDeepLookupsWorkload(): BenchmarkWorkload {
  const items = Array.from({ length: 600 }, (_, index) => ({
    metadata: {
      labels: {
        primary: `primary-${index}`,
        secondary: `secondary-${index % 17}`,
      },
      annotations: {
        owner: `owner-${index % 23}`,
      },
    },
    values: [index, index + 1, index + 2],
  }));
  const source = [
    '{% set section = "labels" %}',
    '{% set field = "secondary" %}',
    '{% for item in items %}',
    '${{ item.metadata.labels.primary }}:',
    '${{ item["metadata"][section][field] }}:',
    '${{ item.metadata.annotations.owner }}:',
    '${{ item.values[1] }}:',
    '${{ missing.path.value }}\n',
    '{% endfor %}',
  ].join('');
  return {
    kind: 'static',
    id: 'deep-lookups',
    description: `${items.length} records with constant, computed, indexed, and missing deep lookups`,
    sources: [source],
    context: { items },
  };
}

function createMacrosScopesWorkload(): BenchmarkWorkload {
  const items = Array.from({ length: 450 }, (_, index) => ({
    name: `item-${index}`,
    values: [index, index + 1, index + 2],
  }));
  const source = [
    '{% macro cell(value, prefix="v", suffix="!") %}',
    '${{ prefix }}${{ value }}${{ suffix }}',
    '{% endmacro %}',
    '{% macro row(item, marker="row") %}',
    '{% set local = marker ~ ":" ~ item.name %}',
    '${{ local }}[',
    '{% for value in item.values %}',
    '${{ cell(value, prefix="n", suffix=";") }}',
    '{% endfor %}]',
    '{% endmacro %}',
    '{% for item in items %}${{ row(item, marker="entry") }}\n{% endfor %}',
  ].join('');
  return {
    kind: 'static',
    id: 'macros-scopes',
    description: `${items.length} nested macro calls with defaults, keywords, loops, and local assignments`,
    sources: [source],
    context: { items },
  };
}

function createFilterPipelinesWorkload(): BenchmarkWorkload {
  const items = Array.from({ length: 900 }, (_, index) => ({
    name: `item-${String(index).padStart(4, '0')}`,
    category: ['alpha', 'beta', 'gamma'][index % 3]!,
    score: (index * 37) % 1000,
    enabled: index % 4 !== 0,
  }));
  const source = [
    '{% for category, entries in items | groupby("category") %}',
    '${{ category | upper }}:',
    '${{ entries | selectattr("enabled") | sort(false, false, "score") | join(",", "name") }}:',
    '${{ entries | sum("score") }}:',
    '${{ entries | sort(true, false, "score") | first | dump }}\n',
    '{% endfor %}',
  ].join('');
  return {
    kind: 'static',
    id: 'filter-pipelines',
    description: `${items.length} records through grouping, selection, sorting, joining, summing, and JSON filters`,
    sources: [source],
    context: { items },
  };
}

function createEvolvingContextWorkload(): BenchmarkWorkload {
  const updates = Array.from({ length: 500 }, (_, sequence) => ({
    sequence,
    status: sequence % 2 === 0 ? 'ready' : 'running',
    payload: { value: `result-${sequence}` },
  }));
  return {
    kind: 'evolving-context',
    id: 'evolving-context',
    description: `${updates.length} simple renders while replacing one nested prepared-context output`,
    source: [
      '${{ project.name }}:',
      '${{ steps.current.output.sequence }}:',
      '${{ steps.current.output.status }}:',
      '${{ steps.current.output.payload.value }}\n',
    ].join(''),
    context: {
      project: { name: 'evolving-context' },
      steps: { current: { output: null } },
    },
    updates,
  };
}

/** Significant output-equivalent synchronous workloads. */
export const benchmarkWorkloads: readonly BenchmarkWorkload[] = Object.freeze([
  createTemplateFilesWorkload(),
  createExpressionWorkload(),
  createTinyTemplatesWorkload(),
  createDeepLookupsWorkload(),
  createMacrosScopesWorkload(),
  createFilterPipelinesWorkload(),
  createEvolvingContextWorkload(),
]);
