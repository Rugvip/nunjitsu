import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

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
   * Implementations must honor cancellation before returning host data.
   */
  load(name: string, signal?: AbortSignal): Promise<LoadedTemplate | null>;
}

/** Configuration for a filesystem loader constrained to explicit roots. */
export interface FileSystemLoaderOptions {
  /** Absolute directories that may contain template sources, in lookup order. */
  roots: readonly string[];
}

/** A failure while resolving a named template through trusted loaders. */
export class TemplateLoaderError extends Error {
  /** Creates a loader failure with a stable user-facing message. */
  constructor(message: string) {
    super(message);
    this.name = 'TemplateLoaderError';
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
    async load(name: string, signal?: AbortSignal): Promise<LoadedTemplate | null> {
      throwIfAborted(signal);
      const source = sources.get(name);
      return source === undefined
        ? null
        : { canonicalName: `memory:${encodeURIComponent(name)}`, source };
    },
  });
}

/** Creates a loader that prevents lexical and symlink escape from configured roots. */
export function fileSystemLoader(options: FileSystemLoaderOptions): TemplateLoader {
  if (options.roots.length === 0) {
    throw new TypeError('A filesystem loader requires at least one root');
  }
  const roots = options.roots.map(root => {
    if (!isAbsolute(root)) {
      throw new TypeError(`Template root must be absolute: ${root}`);
    }
    return root;
  });

  return Object.freeze({
    async load(name: string, signal?: AbortSignal): Promise<LoadedTemplate | null> {
      validateTemplateName(name);
      if (isAbsolute(name)) {
        throw new TemplateLoaderError('Absolute template names are not allowed');
      }
      throwIfAborted(signal);

      for (const configuredRoot of roots) {
        const root = await realpath(configuredRoot);
        const lexicalCandidate = resolve(root, name);
        if (!isWithinRoot(root, lexicalCandidate)) {
          throw new TemplateLoaderError(`Template path escapes its configured root: ${name}`);
        }

        let canonicalPath: string;
        try {
          canonicalPath = await realpath(lexicalCandidate);
        } catch (error) {
          if (isMissingFileError(error)) {
            continue;
          }
          throw error;
        }
        if (!isWithinRoot(root, canonicalPath)) {
          throw new TemplateLoaderError(`Template symlink escapes its configured root: ${name}`);
        }
        throwIfAborted(signal);
        const source = await readFile(canonicalPath, { encoding: 'utf8', signal });
        return { canonicalName: pathToFileURL(canonicalPath).href, source };
      }
      return null;
    },
  });
}

/** Resolves the first matching source from an immutable loader chain. */
export async function loadTemplate(
  loaders: readonly TemplateLoader[],
  name: string,
  signal?: AbortSignal,
): Promise<LoadedTemplate> {
  validateTemplateName(name);
  for (const loader of loaders) {
    throwIfAborted(signal);
    const loaded = await loader.load(name, signal);
    if (loaded) {
      if (!loaded.canonicalName || typeof loaded.source !== 'string') {
        throw new TemplateLoaderError(`Loader returned an invalid template for ${name}`);
      }
      return loaded;
    }
  }
  throw new TemplateLoaderError(`Template not found: ${name}`);
}

function validateTemplateName(name: string): void {
  if (!name || name.includes('\0')) {
    throw new TemplateLoaderError('Template names must be non-empty and cannot contain NUL');
  }
}

function isWithinRoot(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const error = new Error('Template loading was aborted');
    error.name = 'AbortError';
    throw error;
  }
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
