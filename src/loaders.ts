import { readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
    async load(
      name: string,
      signal?: AbortSignal,
      from?: string,
    ): Promise<LoadedTemplate | null> {
      validateTemplateName(name);
      if (isAbsolute(name)) {
        throw new TemplateLoaderError('Absolute template names are not allowed');
      }
      throwIfAborted(signal);
      const relativeBase = resolveFileSystemBase(name, from);
      const canonicalRelativeBase = relativeBase === undefined
        ? undefined
        : await realpath(relativeBase);
      let relativeCandidateWithinRoot = false;

      for (const configuredRoot of roots) {
        const root = await realpath(configuredRoot);
        const lexicalCandidate = resolve(canonicalRelativeBase ?? root, name);
        if (!isWithinRoot(root, lexicalCandidate)) {
          if (canonicalRelativeBase !== undefined) {
            continue;
          }
          throw new TemplateLoaderError(`Template path escapes its configured root: ${name}`);
        }
        relativeCandidateWithinRoot = true;

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
      if (canonicalRelativeBase !== undefined && !relativeCandidateWithinRoot) {
        throw new TemplateLoaderError(`Template path escapes its configured root: ${name}`);
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

function resolveFileSystemBase(name: string, from: string | undefined): string | undefined {
  if (!isRelativeTemplateName(name) || !from?.startsWith('file:')) {
    return undefined;
  }
  try {
    return dirname(fileURLToPath(from));
  } catch {
    throw new TemplateLoaderError(`Invalid filesystem template identity: ${from}`);
  }
}

function isRelativeTemplateName(name: string): boolean {
  return name.startsWith('./') || name.startsWith('../');
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
