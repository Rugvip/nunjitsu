import type { TemplateCapabilities } from './capabilities.ts';
import {
  loadTemplate,
  TemplateLoaderError,
  TemplateNotFoundError,
  type LoadedTemplate,
  type TemplateLoader,
} from './loaders.ts';
import { NunjitsuLimitError, normalizeRenderLimits, type RenderLimits } from './limits.ts';
import {
  evaluateTemplate,
  evaluateTemplateStream,
  type RuntimeHost,
} from './runtime/evaluator.ts';
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

class HostLoaderFailure extends Error {
  readonly original: unknown;

  constructor(original: unknown) {
    super('Trusted template loader failed', { cause: original });
    this.original = original;
  }
}

/** Creates an immutable native TypeScript engine synchronously. */
export function createNativeEngine(options: EngineOptions = {}): Engine {
  const loaders = Object.freeze([...(options.loaders ?? [])]);
  const autoescape = options.autoescape ?? true;
  const trimBlocks = options.trimBlocks ?? false;
  const lstripBlocks = options.lstripBlocks ?? false;
  const capabilities = createRuntimeHost(options);

  const execute = async (
    template: TemplateInput,
    context: TemplateContext = {},
    renderOptions: RenderOptions = {},
    emit?: (value: string) => Promise<void>,
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
      if (
        template.canonicalName !== undefined &&
        (typeof template.canonicalName !== 'string' ||
          template.canonicalName.length === 0 ||
          template.canonicalName.includes('\0'))
      ) {
        throw new TypeError('canonicalName must be a non-empty string without NUL');
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
          if (error instanceof TemplateLoaderError || error instanceof DOMException) {
            throw error;
          }
          throw new HostLoaderFailure(error);
        }
      },
    });
    try {
      if (emit) {
        await evaluateTemplateStream(resolved.source, context, {
          autoescape,
          trimBlocks,
          lstripBlocks,
          limits: evaluatorLimits,
          signal,
          host,
          canonicalName: resolved.canonicalName,
        }, emit);
        return '';
      }
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
      if (error instanceof HostLoaderFailure) {
        throw error.original;
      }
      if (
        error instanceof TypeError ||
        error instanceof RangeError ||
        error instanceof DOMException ||
        (error instanceof Error && error.name === 'AbortError') ||
        error instanceof TemplateLoaderError ||
        error instanceof NunjitsuLimitError
      ) {
        throw error;
      }
      const message = error instanceof Error ? error.message : 'Template rendering failed';
      throw new NunjitsuRenderError(message, resolved.canonicalName, error);
    }
  };
  const render: Engine['render'] = async (template, context, renderOptions) => {
    return await execute(template, context, renderOptions);
  };

  return Object.freeze({
    render,
    renderStream(
      template: TemplateInput,
      context: TemplateContext = {},
      renderOptions: RenderOptions = {},
    ) {
      let started = false;
      let cancelled = false;
      let demand = 0;
      let resumeDemand: (() => void) | undefined;
      const cancellation = new AbortController();
      const signal = renderOptions.signal
        ? AbortSignal.any([renderOptions.signal, cancellation.signal])
        : cancellation.signal;
      return new ReadableStream<string>({
        pull(controller) {
          demand += 1;
          resumeDemand?.();
          resumeDemand = undefined;
          if (!started) {
            started = true;
            void execute(template, context, { ...renderOptions, signal }, async value => {
              for (const chunk of splitUtf8(value, 64 * 1024)) {
                if (demand === 0) {
                  await new Promise<void>(resolve => {
                    resumeDemand = resolve;
                  });
                }
                throwIfAborted(signal);
                demand -= 1;
                controller.enqueue(chunk);
                if (demand === 0) {
                  await new Promise<void>(resolve => {
                    resumeDemand = resolve;
                  });
                }
                throwIfAborted(signal);
              }
            }).then(() => {
              if (!cancelled) {
                controller.close();
              }
            }, error => {
              if (!cancelled) {
                controller.error(error);
              }
            });
          }
        },
        cancel(reason) {
          cancelled = true;
          cancellation.abort(
            reason instanceof Error
              ? reason
              : new DOMException('The output stream was cancelled', 'AbortError'),
          );
          resumeDemand?.();
          resumeDemand = undefined;
        },
      });
    },
  });
}

function splitUtf8(value: string, maximumBytes: number): readonly string[] {
  if (value.length === 0) {
    return [];
  }
  const chunks: string[] = [];
  let chunk = '';
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes > 0 && bytes + characterBytes > maximumBytes) {
      chunks.push(chunk);
      chunk = '';
      bytes = 0;
    }
    chunk += character;
    bytes += characterBytes;
  }
  if (chunk.length > 0) {
    chunks.push(chunk);
  }
  return chunks;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException('The operation was aborted', 'AbortError');
  }
}
