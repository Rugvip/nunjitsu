import type { TemplateCapabilities } from './capabilities.ts';
import { NunjitsuLimitError, normalizeRenderLimits, type RenderLimits } from './limits.ts';
import { evaluateRuntimeTemplate } from './runtime/evaluator.ts';
import { createRuntimeHost } from './runtime/host.ts';
import {
  copyRuntimeContext,
  copyRuntimeValue,
  RuntimeRecord,
  withRuntimeContextPath,
} from './runtime/value.ts';
import type { TemplateContext, TemplateValue } from './values.ts';

/** Configures an immutable Backstage-compatible Nunjitsu engine. */
export interface EngineOptions extends TemplateCapabilities {
  /** Uses `{{ ... }}` variables and supported Jinja compatibility behavior. */
  cookiecutterCompat?: boolean;
  /** Removes one LF or CRLF immediately after each block tag. */
  trimBlocks?: boolean;
  /** Removes indentation before block tags on otherwise blank lines. */
  lstripBlocks?: boolean;
}

/** Per-render cooperative resource limits. */
export interface RenderOptions {
  /** High finite defaults may be tightened or explicitly set to `Infinity`. */
  limits?: Partial<RenderLimits>;
}

/**
 * An immutable engine-owned copy of template context data.
 *
 * The snapshot retains copied values until it becomes unreachable. It can only
 * be rendered by the engine that created it and never observes later host
 * object mutation.
 */
export interface PreparedContext {
  /**
   * Returns a structurally shared snapshot with one nested value replaced.
   *
   * Missing record segments are created. Existing non-record segments,
   * reserved names, accessors, behavior, and unsupported values are rejected.
   */
  withPath(path: readonly string[], value: TemplateValue): PreparedContext;
}

/** An immutable synchronous template engine. */
export interface Engine {
  /** Copies and validates context data once for reuse across renders. */
  prepareContext(context?: TemplateContext): PreparedContext;
  /** Parses and renders one complete inline template source. */
  render(
    source: string,
    context?: TemplateContext | PreparedContext,
    options?: RenderOptions,
  ): string;
}

/** Internal ownership and value state for one opaque prepared context. */
interface PreparedContextState {
  readonly owner: object;
  readonly value: RuntimeRecord;
}

const preparedContextStates = new WeakMap<object, PreparedContextState>();

/** A structured parse or evaluation failure from the closed interpreter. */
export class NunjitsuRenderError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'NunjitsuRenderError';
  }
}

/** Creates an immutable native TypeScript engine synchronously. */
export function createNativeEngine(options: EngineOptions = {}): Engine {
  const cookiecutterCompat = options.cookiecutterCompat ?? false;
  const trimBlocks = options.trimBlocks ?? false;
  const lstripBlocks = options.lstripBlocks ?? false;
  const host = createRuntimeHost(options);
  const contextOwner = Object.freeze({});
  const emptyContext = new RuntimeRecord([]);

  return Object.freeze({
    prepareContext(context: TemplateContext = {}): PreparedContext {
      return createPreparedContext(contextOwner, copyRuntimeContext(context));
    },
    render(
      source: string,
      context?: TemplateContext | PreparedContext,
      renderOptions: RenderOptions = {},
    ): string {
      if (typeof source !== 'string') {
        throw new TypeError('Template source must be a string');
      }
      try {
        return evaluateRuntimeTemplate(source, resolveRuntimeContext(
          contextOwner,
          context,
          emptyContext,
        ), {
          cookiecutterCompat,
          trimBlocks,
          lstripBlocks,
          limits: normalizeRenderLimits(renderOptions.limits),
          host,
        });
      } catch (error) {
        if (
          error instanceof TypeError ||
          error instanceof RangeError ||
          error instanceof NunjitsuLimitError
        ) {
          throw error;
        }
        const message = error instanceof Error ? error.message : 'Template rendering failed';
        throw new NunjitsuRenderError(message, error);
      }
    },
  });
}

function createPreparedContext(
  owner: object,
  value: RuntimeRecord,
): PreparedContext {
  const prepared = Object.freeze({
    withPath(path: readonly string[], publicValue: TemplateValue): PreparedContext {
      return createPreparedContext(
        owner,
        withRuntimeContextPath(value, path, copyRuntimeValue(publicValue)),
      );
    },
  });
  preparedContextStates.set(prepared, { owner, value });
  return prepared;
}

function resolveRuntimeContext(
  owner: object,
  context: TemplateContext | PreparedContext | undefined,
  emptyContext: RuntimeRecord,
): RuntimeRecord {
  if (context === undefined) {
    return emptyContext;
  }
  const state = preparedContextStates.get(context);
  if (state) {
    if (state.owner !== owner) {
      throw new TypeError('Prepared context belongs to a different engine');
    }
    return state.value;
  }
  return copyRuntimeContext(context as TemplateContext);
}
