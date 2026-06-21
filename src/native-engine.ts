import type { TemplateCapabilities } from './capabilities.ts';
import {
  loadTemplate,
  TemplateNotFoundError,
  type LoadedTemplate,
  type TemplateLoader,
} from './loaders.ts';
import { normalizeRenderLimits, type RenderLimits } from './limits.ts';
import { evaluateTemplate, type RuntimeHost } from './runtime/evaluator.ts';
import { createRuntimeHost } from './runtime/host.ts';
import type { TemplateContext } from './values.ts';

/** Configures an immutable native Nunjitsu engine. */
export interface EngineOptions extends TemplateCapabilities {
  /** Trusted template loaders fixed for the lifetime of this engine. */
  loaders?: readonly TemplateLoader[];
  /** Escapes interpolated values. Defaults to `true`, matching Nunjucks. */
  autoescape?: boolean;
  /** Removes one LF or CRLF immediately after each block tag. */
  trimBlocks?: boolean;
  /** Removes indentation before block tags on otherwise blank lines. */
  lstripBlocks?: boolean;
}

/** An inline template parsed and rendered only for the current call. */
export interface InlineTemplate {
  /** Untrusted template source. */
  source: string;
  /** Stable identity used as the base for relative dependencies. */
  canonicalName?: string;
}

/** A template resolved by name through the engine's explicit loader chain. */
export interface NamedTemplate {
  /** Loader-specific template name. */
  name: string;
}

/** Inline or explicitly loaded template input accepted by rendering methods. */
export type TemplateInput = InlineTemplate | NamedTemplate;

/** Per-render controls that do not alter engine-level authority. */
export interface RenderOptions {
  /** Cancels parsing, evaluation, loading, or capability work. */
  signal?: AbortSignal;
  /** High finite defaults may be tightened or explicitly set to `Infinity`. */
  limits?: Partial<RenderLimits>;
}

/** An immutable native Nunjitsu engine. */
export interface Engine {
  /** Parses and renders a template to one buffered string. */
  render(
    template: TemplateInput,
    context?: TemplateContext,
    options?: RenderOptions,
  ): Promise<string>;

  /** Renders through a pull-driven Web stream which may fail after earlier output. */
  renderStream(
    template: TemplateInput,
    context?: TemplateContext,
    options?: RenderOptions,
  ): ReadableStream<string>;
}

/** A structured parse or evaluation failure from the native interpreter. */
export class NunjitsuRenderError extends Error {
  /** Stable identity of the template being rendered, when known. */
  readonly templateName: string | undefined;

  constructor(message: string, templateName?: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'NunjitsuRenderError';
    this.templateName = templateName;
  }
}

/** Creates an immutable native TypeScript engine synchronously. */
export function createNativeEngine(options: EngineOptions = {}): Engine {
  const loaders = Object.freeze([...(options.loaders ?? [])]);
  const autoescape = options.autoescape ?? true;
  const trimBlocks = options.trimBlocks ?? false;
  const lstripBlocks = options.lstripBlocks ?? false;
  const capabilities = createRuntimeHost(options);

  const render = async (
    template: TemplateInput,
    context: TemplateContext = {},
    renderOptions: RenderOptions = {},
  ): Promise<string> => {
    const signal = renderOptions.signal ?? new AbortController().signal;
    throwIfAborted(signal);
    const limits = normalizeRenderLimits(renderOptions.limits);
    let resolved: LoadedTemplate;
    let loaderCalls = 0;
    if ('source' in template) {
      if (typeof template.source !== 'string') {
        throw new TypeError('Inline template source must be a string');
      }
      resolved = {
        source: template.source,
        canonicalName: template.canonicalName ?? 'inline:anonymous',
      };
    } else {
      loaderCalls += 1;
      resolved = await loadTemplate(loaders, template.name, signal);
    }
    const evaluatorLimits = Object.freeze({
      ...limits,
      loaderCalls: limits.loaderCalls === Number.POSITIVE_INFINITY
        ? limits.loaderCalls
        : Math.max(0, limits.loaderCalls - loaderCalls),
    });
    const host: RuntimeHost = Object.freeze({
      ...capabilities,
      async load(
        name: string,
        from: string | undefined,
        ignoreMissing: boolean,
        activeSignal: AbortSignal,
      ) {
        try {
          return await loadTemplate(loaders, name, activeSignal, from);
        } catch (error) {
          if (ignoreMissing && error instanceof TemplateNotFoundError) {
            return undefined;
          }
          throw error;
        }
      },
    });
    try {
      return await evaluateTemplate(resolved.source, context, {
        autoescape,
        trimBlocks,
        lstripBlocks,
        limits: evaluatorLimits,
        signal,
        host,
        canonicalName: resolved.canonicalName,
      });
    } catch (error) {
      if (
        error instanceof TypeError ||
        error instanceof RangeError ||
        error instanceof DOMException ||
        error?.constructor?.name === 'NunjitsuLimitError' ||
        error?.constructor?.name === 'TemplateLoaderError'
      ) {
        throw error;
      }
      const message = error instanceof Error ? error.message : 'Template rendering failed';
      throw new NunjitsuRenderError(message, resolved.canonicalName, error);
    }
  };

  return Object.freeze({
    render,
    renderStream(
      template: TemplateInput,
      context: TemplateContext = {},
      renderOptions: RenderOptions = {},
    ) {
      let started = false;
      return new ReadableStream<string>({
        async pull(controller) {
          if (started) {
            return;
          }
          started = true;
          try {
            controller.enqueue(await render(template, context, renderOptions));
            controller.close();
          } catch (error) {
            controller.error(error);
          }
        },
      });
    },
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException('The operation was aborted', 'AbortError');
  }
}
