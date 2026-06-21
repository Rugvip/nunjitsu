import type { TemplateCapabilities } from './capabilities.ts';
import { NunjitsuLimitError, normalizeRenderLimits, type RenderLimits } from './limits.ts';
import { evaluateTemplate } from './runtime/evaluator.ts';
import { createRuntimeHost } from './runtime/host.ts';
import type { TemplateContext } from './values.ts';

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

/** An immutable synchronous template engine. */
export interface Engine {
  /** Parses and renders one complete inline template source. */
  render(
    source: string,
    context?: TemplateContext,
    options?: RenderOptions,
  ): string;
}

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

  return Object.freeze({
    render(
      source: string,
      context: TemplateContext = {},
      renderOptions: RenderOptions = {},
    ): string {
      if (typeof source !== 'string') {
        throw new TypeError('Template source must be a string');
      }
      try {
        return evaluateTemplate(source, context, {
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
