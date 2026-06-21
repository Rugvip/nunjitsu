/** Configurable denial-of-service limits for one render. */
export interface RenderLimits {
  /** Maximum total UTF-16 source code units parsed across one render. */
  sourceCodeUnits: number;
  /** Maximum total immutable AST nodes parsed across one render. */
  astNodes: number;
  /** Maximum evaluator work units. */
  workUnits: number;
  /** Maximum nested interpreter evaluation depth. */
  nestingDepth: number;
  /** Maximum rendered JavaScript UTF-16 code units. */
  outputCodeUnits: number;
  /** Maximum estimated UTF-8 bytes in values supplied to one filter. */
  scratchBytes: number;
  /** Maximum trusted host filter and global-function invocations. */
  capabilityCalls: number;
}

/** Fully populated limits passed to the native parser and evaluator. */
export type NormalizedRenderLimits = Readonly<RenderLimits>;

/** A render rejected after exceeding one configured resource dimension. */
export class NunjitsuLimitError extends Error {
  /** Limit name when the host can identify the failed dimension. */
  readonly limit: keyof RenderLimits | undefined;

  /** Creates a deterministic resource-limit failure. */
  constructor(limit?: keyof RenderLimits) {
    super(limit ? `Nunjitsu render exceeded ${limit}` : 'Nunjitsu render exceeded a resource limit');
    this.name = 'NunjitsuLimitError';
    this.limit = limit;
  }
}

const defaultLimits: NormalizedRenderLimits = Object.freeze({
  sourceCodeUnits: 4 * 1024 * 1024,
  astNodes: 1_000_000,
  workUnits: 1_000_000,
  nestingDepth: 512,
  outputCodeUnits: 16 * 1024 * 1024,
  scratchBytes: 64 * 1024 * 1024,
  capabilityCalls: 4096,
});

/** Applies finite defaults and validates explicit per-render overrides. */
export function normalizeRenderLimits(
  limits: Partial<RenderLimits> | undefined,
): NormalizedRenderLimits {
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
