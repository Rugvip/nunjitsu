import type { TemplateCapabilities } from './capabilities.ts';
import { neutralizeDiagnosticMessage } from './diagnostics.ts';
import { NunjitsuLimitError, normalizeRenderLimits, type RenderLimits } from './limits.ts';
import { NunjitsuParseError } from './parser/index.ts';
import { clearLegacyRegExpState } from './runtime/clearLegacyRegExpState.ts';
import { evaluateRuntimeTemplate } from './runtime/evaluator.ts';
import { createRuntimeHost } from './runtime/host.ts';
import { RuntimeEvaluationError } from './runtime/RuntimeEvaluationError.ts';
import {
  copyRuntimeContext,
  copyRuntimeValue,
  RuntimeRecord,
  withRuntimeContextPath,
} from './runtime/value.ts';
import type { TemplateContext, TemplateValue } from './values.ts';

/** Configures an immutable secure direct-string Nunjitsu engine. */
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
  /**
   * Parses and renders one complete inline template source.
   *
   * Invalid API inputs throw `TypeError` or `RangeError`. Evaluation resource
   * exhaustion throws `NunjitsuLimitError`; all other parser and evaluator
   * failures throw `NunjitsuRenderError` without returning partial output.
   */
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

/** Stable category for a public template render failure. */
export type NunjitsuRenderErrorCode =
  | 'syntax_error'
  | 'evaluation_error'
  | 'capability_error';

/** Stage of template processing that produced a public render failure. */
export type NunjitsuRenderErrorPhase = 'parse' | 'evaluate';

/** Engine-owned structured details for a public render failure. */
export interface NunjitsuRenderErrorDetails {
  /** Stable machine-readable failure category. */
  readonly code: NunjitsuRenderErrorCode;
  /** Template processing stage that failed. */
  readonly phase: NunjitsuRenderErrorPhase;
  /** One-based template line when the engine can identify it. */
  readonly line: number | undefined;
  /** One-based template column when the engine can identify it. */
  readonly column: number | undefined;
}

/** A structured parse or evaluation failure from the closed interpreter. */
export class NunjitsuRenderError extends Error {
  /** Stable machine-readable failure category. */
  readonly code: NunjitsuRenderErrorCode;
  /** Template processing stage that failed. */
  readonly phase: NunjitsuRenderErrorPhase;
  /** One-based template line when the engine can identify it. */
  readonly line: number | undefined;
  /** One-based template column when the engine can identify it. */
  readonly column: number | undefined;
  /** Public render errors never expose an underlying thrown value. */
  declare readonly cause: undefined;

  /** Creates an engine-owned structured render diagnostic. */
  constructor(
    message: string,
    details: NunjitsuRenderErrorDetails = {
      code: 'evaluation_error',
      phase: 'evaluate',
      line: undefined,
      column: undefined,
    },
  ) {
    super(neutralizeDiagnosticMessage(
      typeof message === 'string' ? message : 'Template rendering failed',
    ));
    this.name = 'NunjitsuRenderError';
    this.code = details.code;
    this.phase = details.phase;
    this.line = details.line;
    this.column = details.column;
    Object.defineProperty(this, 'cause', {
      configurable: false,
      enumerable: false,
      value: undefined,
      writable: false,
    });
  }
}

/** Creates an immutable Nunjitsu engine synchronously. */
export function createEngine(options: EngineOptions = {}): Engine {
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
      try {
        if (typeof source !== 'string') {
          throw new TypeError('Template source must be a string');
        }
        const runtimeContext = resolveRuntimeContext(
          contextOwner,
          context,
          emptyContext,
        );
        const limits = normalizeRenderLimits(renderOptions.limits);
        try {
          return evaluateRuntimeTemplate(source, runtimeContext, {
            cookiecutterCompat,
            trimBlocks,
            lstripBlocks,
            limits,
            host,
          });
        } catch (error) {
          if (error instanceof NunjitsuLimitError) {
            throw error;
          }
          const diagnostic = publicRenderDiagnostic(error);
          throw new NunjitsuRenderError(diagnostic.message, diagnostic);
        }
      } finally {
        clearLegacyRegExpState();
      }
    },
  });
}

function publicRenderDiagnostic(
  error: unknown,
): NunjitsuRenderErrorDetails & { readonly message: string } {
  if (error instanceof NunjitsuParseError) {
    return {
      code: 'syntax_error',
      phase: 'parse',
      line: oneBased(error.line),
      column: oneBased(error.column),
      message: error.message,
    };
  }
  if (RuntimeEvaluationError.is(error)) {
    return {
      code: error.code,
      phase: 'evaluate',
      line: oneBased(error.line),
      column: oneBased(error.column),
      message: error.message,
    };
  }
  return {
    code: 'evaluation_error',
    phase: 'evaluate',
    line: undefined,
    column: undefined,
    message: 'Template rendering failed',
  };
}

function oneBased(value: number | undefined): number | undefined {
  return value === undefined ? undefined : value + 1;
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
