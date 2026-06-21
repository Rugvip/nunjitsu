/** Configurable denial-of-service limits for one render. */
export interface RenderLimits {
  /** Maximum parser/evaluator work units. */
  workUnits: number;
  /** Maximum active root/include frame depth. */
  includeDepth: number;
  /** Maximum rendered UTF-8 output bytes. */
  outputBytes: number;
  /** Maximum temporary UTF-8 scratch bytes used during evaluation. */
  scratchBytes: number;
  /** Maximum named-template loader requests, including the entry template. */
  loaderCalls: number;
  /** Maximum trusted host filter, test, and global invocations. */
  capabilityCalls: number;
}

/** Fully populated limits passed to the fixed-memory encoder and evaluator. */
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
  workUnits: 1_000_000,
  includeDepth: 64,
  outputBytes: 16 * 1024 * 1024,
  scratchBytes: 64 * 1024 * 1024,
  loaderCalls: 1024,
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
    if (value > 0xffff_fffe && value !== Number.POSITIVE_INFINITY) {
      throw new RangeError(`${name} exceeds the Wasm32 limit range`);
    }
  }
  return Object.freeze(normalized);
}

/** Encodes a validated limit for the raw Wasm ABI. */
export function encodeRenderLimit(value: number): number {
  return value === Number.POSITIVE_INFINITY ? 0xffff_ffff : value;
}
