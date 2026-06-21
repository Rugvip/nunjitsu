import { posix } from 'node:path';

/** A template source and stable identity returned by a trusted loader. */
export interface LoadedTemplate {
  /** Canonical identity used for render-local deduplication and cycle detection. */
  canonicalName: string;
  /** UTF-8 Nunjucks template source. */
  source: string;
}

/** Trusted host authority that resolves named template sources. */
export interface TemplateLoader {
  /**
   * Resolves a template name, returning `null` when this loader has no match.
   * `from` is the canonical identity of the requesting template when available;
   * implementations may use it to resolve names beginning with `./` or `../`.
   * Implementations must honor cancellation before returning host data.
   */
  load(
    name: string,
    signal?: AbortSignal,
    from?: string,
  ): Promise<LoadedTemplate | null>;
}

/** A failure while resolving a named template through trusted loaders. */
export class TemplateLoaderError extends Error {
  /** Creates a loader failure with a stable user-facing message. */
  constructor(message: string) {
    super(message);
    this.name = 'TemplateLoaderError';
  }
}

/** A template name that no configured loader could resolve. */
export class TemplateNotFoundError extends TemplateLoaderError {
  /** Creates a not-found failure for one validated template name. */
  constructor(name: string) {
    super(`Template not found: ${name}`);
    this.name = 'TemplateNotFoundError';
  }
}

/** Creates an immutable loader backed by an owned copy of template sources. */
export function memoryLoader(templates: Readonly<Record<string, string>>): TemplateLoader {
  const sources = new Map<string, string>();
  for (const [name, source] of Object.entries(templates)) {
    validateTemplateName(name);
    if (typeof source !== 'string') {
      throw new TypeError(`Template ${JSON.stringify(name)} must contain string source`);
    }
    sources.set(name, source);
  }

  return Object.freeze({
    async load(
      name: string,
      signal?: AbortSignal,
      from?: string,
    ): Promise<LoadedTemplate | null> {
      throwIfAborted(signal);
      const resolvedName = resolveMemoryName(name, from);
      const source = sources.get(resolvedName);
      return source === undefined
        ? null
        : { canonicalName: `memory:${encodeURIComponent(resolvedName)}`, source };
    },
  });
}

/** Resolves the first matching source from an immutable loader chain. */
export async function loadTemplate(
  loaders: readonly TemplateLoader[],
  name: string,
  signal?: AbortSignal,
  from?: string,
): Promise<LoadedTemplate> {
  validateTemplateName(name);
  if (from !== undefined) {
    validateCanonicalName(from);
  }
  for (const loader of loaders) {
    throwIfAborted(signal);
    const loaded = await loader.load(name, signal, from);
    if (loaded) {
      if (typeof loaded.source !== 'string') {
        throw new TemplateLoaderError(`Loader returned an invalid template for ${name}`);
      }
      validateCanonicalName(loaded.canonicalName);
      return loaded;
    }
  }
  throw new TemplateNotFoundError(name);
}

function validateTemplateName(name: string): void {
  if (typeof name !== 'string' || !name || name.includes('\0')) {
    throw new TemplateLoaderError('Template names must be non-empty and cannot contain NUL');
  }
}

function validateCanonicalName(name: string): void {
  if (typeof name !== 'string' || !name || name.includes('\0')) {
    throw new TemplateLoaderError(
      'Canonical template identities must be non-empty strings without NUL',
    );
  }
}

function resolveMemoryName(name: string, from: string | undefined): string {
  if (!isRelativeTemplateName(name) || !from?.startsWith('memory:')) {
    return name;
  }
  let parentName: string;
  try {
    parentName = decodeURIComponent(from.slice('memory:'.length));
  } catch {
    throw new TemplateLoaderError(`Invalid memory template identity: ${from}`);
  }
  const resolvedName = posix.normalize(posix.join(posix.dirname(parentName), name));
  if (resolvedName === '..' || resolvedName.startsWith('../')) {
    throw new TemplateLoaderError(`Template path escapes the memory namespace: ${name}`);
  }
  return resolvedName;
}

function isRelativeTemplateName(name: string): boolean {
  return name.startsWith('./') || name.startsWith('../');
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const error = new Error('Template loading was aborted');
    error.name = 'AbortError';
    throw error;
  }
}
