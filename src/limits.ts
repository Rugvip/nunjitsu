/** Configurable denial-of-service limits for one render. */
export interface TemplateRenderLimits {
  /** Maximum total UTF-16 source code units parsed across one render. */
  sourceCodeUnits: number;
  /** Maximum total immutable AST nodes parsed across one render. */
  astNodes: number;
  /** Maximum duplicated static-planning work and evaluator work units per phase. */
  workUnits: number;
  /** Maximum nested interpreter evaluation depth. */
  nestingDepth: number;
  /** Maximum rendered text or equivalent native-result UTF-16 code units. */
  outputCodeUnits: number;
  /** Maximum estimated UTF-8 bytes in values supplied to one filter. */
  scratchBytes: number;
  /** Maximum trusted host filter and global-function invocations. */
  capabilityCalls: number;
}

/** Fully populated limits passed to the native parser and evaluator. */
export type NormalizedTemplateRenderLimits = Readonly<TemplateRenderLimits>;

/** Safe structured context for one resource-limit failure. */
export interface TemplateLimitErrorDetails {
  /** Processing stage in which the limit was exceeded. */
  readonly phase?: 'parse' | 'evaluate' | undefined;
  /** One-based template line when available. */
  readonly line?: number | undefined;
  /** One-based template column when available. */
  readonly column?: number | undefined;
  /** Configured maximum for the failed resource dimension. */
  readonly configured?: number | undefined;
  /** Observed or projected usage that exceeded the maximum. */
  readonly observed?: number | undefined;
}

/** A render rejected after exceeding one configured resource dimension. */
export class TemplateLimitError extends Error {
  /** Limit name when the host can identify the failed dimension. */
  readonly limit: keyof TemplateRenderLimits | undefined;
  /** Processing stage in which the limit was exceeded. */
  readonly phase: 'parse' | 'evaluate' | undefined;
  /** One-based template line when available. */
  readonly line: number | undefined;
  /** One-based template column when available. */
  readonly column: number | undefined;
  /** Configured maximum for the failed resource dimension. */
  readonly configured: number | undefined;
  /** Observed or projected usage that exceeded the maximum. */
  readonly observed: number | undefined;

  /** Creates a deterministic resource-limit failure. */
  constructor(limit?: keyof TemplateRenderLimits, details: TemplateLimitErrorDetails = {}) {
    const resource = limit ? limitDescriptions[limit] : 'resource';
    const usage = details.configured === undefined
      ? ''
      : ` of ${details.configured}` + (
        details.observed === undefined ? '' : ` (observed ${details.observed})`
      );
    const stage = details.phase === 'parse'
      ? 'Template parsing'
      : details.phase === 'evaluate'
        ? 'Template evaluation'
        : 'Template rendering';
    const location = details.line === undefined
      ? ''
      : details.column === undefined
        ? ` at line ${details.line}`
        : ` at line ${details.line}, column ${details.column}`;
    super(`${stage} exceeded the ${resource} limit${usage}${location}`);
    this.name = 'TemplateLimitError';
    this.limit = limit;
    this.phase = details.phase;
    this.line = details.line;
    this.column = details.column;
    this.configured = details.configured;
    this.observed = details.observed;
  }

}

/** Adds missing one-based template context to a renderer-owned limit error. */
export function withTemplateLimitErrorContext(
  error: TemplateLimitError,
  phase: 'parse' | 'evaluate',
  line?: number,
  column?: number,
): TemplateLimitError {
  return new TemplateLimitError(error.limit, {
    phase: error.phase ?? phase,
    line: error.line ?? line,
    column: error.column ?? column,
    configured: error.configured,
    observed: error.observed,
  });
}

const limitDescriptions: Readonly<Record<keyof TemplateRenderLimits, string>> = Object.freeze({
  sourceCodeUnits: 'source code unit',
  astNodes: 'AST node',
  workUnits: 'work unit',
  nestingDepth: 'nesting depth',
  outputCodeUnits: 'output code unit',
  scratchBytes: 'scratch byte',
  capabilityCalls: 'capability call',
});

const defaultLimits: NormalizedTemplateRenderLimits = Object.freeze({
  sourceCodeUnits: 4 * 1024 * 1024,
  astNodes: 1_000_000,
  workUnits: 1_000_000,
  nestingDepth: 512,
  outputCodeUnits: 16 * 1024 * 1024,
  scratchBytes: 64 * 1024 * 1024,
  capabilityCalls: 4096,
});

/** Applies finite defaults and validates explicit per-render overrides. */
export function normalizeTemplateRenderLimits(
  limits: Partial<TemplateRenderLimits> | undefined,
): NormalizedTemplateRenderLimits {
  const normalized = {
    ...defaultLimits,
    ...limits,
  };
  for (const [name, value] of Object.entries(normalized)) {
    if (value !== Number.POSITIVE_INFINITY && (!Number.isSafeInteger(value) || value < 0)) {
      throw new RangeError(`${name} must be a non-negative integer or Infinity`);
    }
  }
  return Object.freeze(normalized);
}
