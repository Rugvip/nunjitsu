import type { TemplateCapabilities } from './capabilities.ts';
import { neutralizeDiagnosticMessage } from './diagnostics.ts';
import { TemplateLimitError, normalizeTemplateRenderLimits, type TemplateRenderLimits } from './limits.ts';
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

/** Configures an immutable secure direct-string template renderer. */
export interface TemplateRendererOptions extends TemplateCapabilities {
  /** Uses `{{ ... }}` variables and supported Jinja compatibility behavior. */
  cookiecutterCompat?: boolean;
  /** Removes one LF or CRLF immediately after each block tag. */
  trimBlocks?: boolean;
  /** Removes indentation before block tags on otherwise blank lines. */
  lstripBlocks?: boolean;
}

/** Per-render cooperative resource limits. */
export interface TemplateRenderOptions {
  /** High finite defaults may be tightened or explicitly set to `Infinity`. */
  limits?: Partial<TemplateRenderLimits>;
}

/**
 * An immutable renderer-owned copy of template context data.
 *
 * The snapshot retains copied values until it becomes unreachable. It can only
 * be rendered by the renderer that created it and never observes later host
 * object mutation.
 */
export interface PreparedTemplateContext {
  /**
   * Returns a structurally shared snapshot with one nested value replaced.
   *
   * Missing record segments are created. Existing non-record segments,
   * reserved names, accessors, behavior, and unsupported values are rejected.
   */
  withPath(path: readonly string[], value: TemplateValue): PreparedTemplateContext;
}

/** An immutable synchronous template renderer. */
export interface TemplateRenderer {
  /** Copies and validates context data once for reuse across renders. */
  prepareContext(context?: TemplateContext): PreparedTemplateContext;
  /**
   * Parses and renders one complete inline template source.
   *
   * Invalid API inputs throw `TypeError` or `RangeError`. Evaluation resource
   * exhaustion throws `TemplateLimitError`; all other parser and evaluator
   * failures throw `TemplateRenderError` without returning partial output.
   */
  render(
    source: string,
    context?: TemplateContext | PreparedTemplateContext,
    options?: TemplateRenderOptions,
  ): string;
}

/** Internal ownership and value state for one opaque prepared context. */
interface PreparedTemplateContextState {
  readonly owner: object;
  readonly value: RuntimeRecord;
}

const preparedTemplateContextStates = new WeakMap<object, PreparedTemplateContextState>();

/** Stable category for a public template render failure. */
export type TemplateRenderErrorCode =
  | 'syntax_error'
  | 'evaluation_error'
  | 'capability_error';

/** Stage of template processing that produced a public render failure. */
export type TemplateRenderErrorPhase = 'parse' | 'evaluate';

/** Renderer-owned structured details for a public render failure. */
export interface TemplateRenderErrorDetails {
  /** Stable machine-readable failure category. */
  readonly code: TemplateRenderErrorCode;
  /** Template processing stage that failed. */
  readonly phase: TemplateRenderErrorPhase;
  /** One-based template line when the renderer can identify it. */
  readonly line: number | undefined;
  /** One-based template column when the renderer can identify it. */
  readonly column: number | undefined;
}

/** A structured parse or evaluation failure from the closed interpreter. */
export class TemplateRenderError extends Error {
  /** Stable machine-readable failure category. */
  readonly code: TemplateRenderErrorCode;
  /** Template processing stage that failed. */
  readonly phase: TemplateRenderErrorPhase;
  /** One-based template line when the renderer can identify it. */
  readonly line: number | undefined;
  /** One-based template column when the renderer can identify it. */
  readonly column: number | undefined;
  /** Public render errors never expose an underlying thrown value. */
  declare readonly cause: undefined;

  /** Creates a renderer-owned structured render diagnostic. */
  constructor(
    message: string,
    details: TemplateRenderErrorDetails = {
      code: 'evaluation_error',
      phase: 'evaluate',
      line: undefined,
      column: undefined,
    },
  ) {
    const detail = typeof message === 'string' ? message : 'Template rendering failed';
    const location = details.line === undefined
      ? ''
      : details.column === undefined
        ? `Template error at line ${details.line}: `
        : `Template error at line ${details.line}, column ${details.column}: `;
    super(neutralizeDiagnosticMessage(`${location}${detail}`));
    this.name = 'TemplateRenderError';
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

/** Creates an immutable template renderer synchronously. */
export function createTemplateRenderer(
  options: TemplateRendererOptions = {},
): TemplateRenderer {
  const cookiecutterCompat = options.cookiecutterCompat ?? false;
  const trimBlocks = options.trimBlocks ?? false;
  const lstripBlocks = options.lstripBlocks ?? false;
  const host = createRuntimeHost(options);
  const rendererOwner = Object.freeze({});
  const emptyContext = new RuntimeRecord([]);

  return Object.freeze({
    prepareContext(context: TemplateContext = {}): PreparedTemplateContext {
      return createPreparedTemplateContext(rendererOwner, copyRuntimeContext(context));
    },
    render(
      source: string,
      context?: TemplateContext | PreparedTemplateContext,
      renderOptions: TemplateRenderOptions = {},
    ): string {
      try {
        if (typeof source !== 'string') {
          throw new TypeError('Template source must be a string');
        }
        const runtimeContext = resolveRuntimeContext(
          rendererOwner,
          context,
          emptyContext,
        );
        const limits = normalizeTemplateRenderLimits(renderOptions.limits);
        try {
          return evaluateRuntimeTemplate(source, runtimeContext, {
            cookiecutterCompat,
            trimBlocks,
            lstripBlocks,
            limits,
            host,
          });
        } catch (error) {
          if (error instanceof TemplateLimitError) {
            throw error;
          }
          const diagnostic = publicRenderDiagnostic(error);
          throw new TemplateRenderError(diagnostic.message, diagnostic);
        }
      } finally {
        clearLegacyRegExpState();
      }
    },
  });
}

function publicRenderDiagnostic(
  error: unknown,
): TemplateRenderErrorDetails & { readonly message: string } {
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

function createPreparedTemplateContext(
  owner: object,
  value: RuntimeRecord,
): PreparedTemplateContext {
  const prepared = Object.freeze({
    withPath(path: readonly string[], publicValue: TemplateValue): PreparedTemplateContext {
      return createPreparedTemplateContext(
        owner,
        withRuntimeContextPath(value, path, copyRuntimeValue(publicValue)),
      );
    },
  });
  preparedTemplateContextStates.set(prepared, { owner, value });
  return prepared;
}

function resolveRuntimeContext(
  owner: object,
  context: TemplateContext | PreparedTemplateContext | undefined,
  emptyContext: RuntimeRecord,
): RuntimeRecord {
  if (context === undefined) {
    return emptyContext;
  }
  const state = preparedTemplateContextStates.get(context);
  if (state) {
    if (state.owner !== owner) {
      throw new TypeError('Prepared context belongs to a different template renderer');
    }
    return state.value;
  }
  return copyRuntimeContext(context as TemplateContext);
}
