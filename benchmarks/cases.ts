import type { TemplateContext } from '../src/index.ts';

/** Stable identifier accepted by the benchmark CLI. */
export type BenchmarkCaseId = 'template-graph' | 'expressions' | 'capabilities';

/** One source string compiled and rendered afresh for every iteration. */
export interface InlineBenchmarkTemplate {
  /** Selects inline rendering. */
  type: 'inline';
  /** Nunjucks-compatible source used by both engines. */
  source: string;
}

/** One named entry and its complete in-memory dependency graph. */
export interface NamedBenchmarkTemplate {
  /** Selects loader-backed named rendering. */
  type: 'named';
  /** Entry template requested for every iteration. */
  name: string;
  /** Immutable virtual files exposed to both engines without parsed-template caching. */
  files: Readonly<Record<string, string>>;
}

/** Equivalent input, context, and capability requirements for one workload. */
export interface BenchmarkWorkload {
  /** Stable command-line identifier. */
  id: BenchmarkCaseId;
  /** Human-readable stress profile. */
  description: string;
  /** Inline source or named template graph. */
  template: InlineBenchmarkTemplate | NamedBenchmarkTemplate;
  /** Copied input values shared by both implementations. */
  context: TemplateContext;
  /** Whether the standard benchmark callback set must be installed. */
  capabilities: boolean;
}

const sectionCount = 40;
const itemsPerSection = 8;

function createTemplateGraph(): BenchmarkWorkload {
  const files: Record<string, string> = {
    'layout.njk': [
      '{# The outer layout intentionally contains several comments that must be scanned. #}',
      '<!doctype html><html><head><title>{{ title }}</title></head><body>',
      '{% block content %}{# default content is replaced #}{% endblock %}',
      '</body></html>',
    ].join('\n'),
  };
  const groups = Array.from({ length: sectionCount }, (_, section) =>
    Array.from({ length: itemsPerSection }, (_, item) => ({
      name: `item-${section}-${item}`,
      value: section * itemsPerSection + item,
      visible: item % 3 !== 0,
    })),
  );
  const includes: string[] = [];

  for (let section = 0; section < sectionCount; section += 1) {
    const metadataName = `metadata-${section % 8}.njk`;
    files[`section-${section}.njk`] = [
      `{# section ${section}: a deliberately long parser-only comment ${'x'.repeat(96)} #}`,
      `<section id="section-${section}">`,
      `{% set heading = "Section ${section}" %}`,
      '<h2>{{ heading }}</h2>',
      `{% for item in groups[${section}] %}`,
      '  {# comments between control-flow and output nodes should produce no output #}',
      '  {% if item.visible %}<p>{{ loop.index }}:{{ item.name }}={{ item.value }}</p>{% endif %}',
      '{% endfor %}',
      `{% include "${metadataName}" %}`,
      '</section>',
    ].join('\n');
    includes.push(`{% include "section-${section}.njk" %}`);
  }

  for (let metadata = 0; metadata < 8; metadata += 1) {
    files[`metadata-${metadata}.njk`] = [
      `{# shared metadata partial ${metadata} #}`,
      `<footer data-shard="${metadata}">{{ title | upper }}:${metadata}</footer>`,
    ].join('\n');
  }

  files['entry.njk'] = [
    '{% extends "layout.njk" %}',
    '{# The entry fans out across many independently parsed sources. #}',
    '{% block content %}',
    ...includes,
    '{% endblock %}',
  ].join('\n');

  return {
    id: 'template-graph',
    description: `${Object.keys(files).length} templates with inheritance, includes, loops, and dense comments`,
    template: { type: 'named', name: 'entry.njk', files },
    context: { title: 'Benchmark', groups },
    capabilities: false,
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
    kind: ['alpha', 'beta', 'gamma', 'delta'][index % 4],
  }));
  const source = [
    '{% for item in items %}',
    '  {% set first = item.base * 7 + item.offset %}',
    '  {% set second = (first // item.divisor) % 97 %}',
    '  {% set third = (second ** 2 + item.factor * 13) % 997 %}',
    '  {% set selected = (third >= 500 and item.enabled) or third == 42 %}',
    '  {% if selected and item.kind in ["alpha", "gamma"] %}H{% else %}L{% endif %}',
    '{{ loop.index0 }}:{{ first }}:{{ second }}:{{ third }}:',
    '{{ item.name ~ ":" ~ (first + second + third) }}\n',
    '{% endfor %}',
  ].join('');

  return {
    id: 'expressions',
    description: `${items.length} loop iterations with arithmetic, powers, comparisons, membership, and concatenation`,
    template: { type: 'inline', source },
    context: { items },
    capabilities: false,
  };
}

function createCapabilityWorkload(): BenchmarkWorkload {
  const items = Array.from({ length: 180 }, (_, index) => ({
    label: `callback-${index}`,
    value: index * 3 + 7,
    offset: index % 11,
    factor: index % 5 + 2,
    minimum: index,
    suffix: index % 2 === 0 ? '!' : '?',
  }));
  const source = [
    '{% for item in items %}',
    '  {% set scaled = item.value | hostOffset(item.offset) | asyncScale(item.factor) %}',
    '  {% set valueChecksum = checksum(item.label) %}',
    '  {% if scaled is above(item.minimum) %}',
    '    {{ formatRow(loop.index0, scaled, valueChecksum)',
    '       | hostWrap("[", "]") | asyncSuffix(item.suffix) }}',
    '  {% else %}unreachable{% endif %}\n',
    '{% endfor %}',
  ].join('');

  return {
    id: 'capabilities',
    description: `${items.length} iterations and 1,260 host filter, test, global, and async callback calls`,
    template: { type: 'inline', source },
    context: { items },
    capabilities: true,
  };
}

/** Significant output-equivalent workloads executed by the comparison harness. */
export const benchmarkWorkloads: readonly BenchmarkWorkload[] = Object.freeze([
  createTemplateGraph(),
  createExpressionWorkload(),
  createCapabilityWorkload(),
]);
