import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';

import { loadTemplate, type TemplateLoader } from './loaders.ts';
import { ArenaWriter, decodeOutput } from './protocol.ts';
import type { TemplateContext } from './values.ts';

const initialMemoryPages = 32;
const maximumMemoryPages = 4096;
const defaultRetainedMemoryBytes = 16 * 1024 * 1024;

/** Identifies the runtime assets used to start workers. */
export interface RuntimeAssets {
  /** URL of the TypeScript source worker or compiled JavaScript worker. */
  workerUrl: URL;
  /** URL of the compiled Rust WebAssembly module. */
  wasmUrl: URL;
}

/** Configures the lazy worker pool. */
export interface WorkerPoolOptions {
  /** Workers created before `createEngine` resolves. Defaults to one. */
  minWorkers?: number;
  /** Maximum simultaneous renders. Defaults to available CPU parallelism. */
  maxWorkers?: number;
}

/** Configures an immutable Nunjitsu engine. */
export interface EngineOptions {
  /** Lazy worker pool bounds. */
  workerPool?: WorkerPoolOptions;
  /** Worker memory retained after a render before that worker is recycled. */
  retainedMemoryBytes?: number;
  /** Trusted template loaders fixed for the lifetime of this engine. */
  loaders?: readonly TemplateLoader[];
  /** Escapes interpolated strings by default. Matches Nunjucks's default of `false`. */
  autoescape?: boolean;
}

/** An inline template accepted by the initial rendering surface. */
export interface InlineTemplate {
  /** UTF-8 template source compiled and rendered for this call only. */
  source: string;
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
  /** Cancels queued or active rendering. Active cancellation recycles its worker. */
  signal?: AbortSignal;
}

/** An initialized asynchronous Nunjitsu engine. */
export interface Engine {
  /** Compiles and renders an inline or explicitly loaded template to one buffered string. */
  render(
    template: TemplateInput,
    context?: TemplateContext,
    options?: RenderOptions,
  ): Promise<string>;

  /** Compiles and renders an inline or explicitly loaded template through a Web stream. */
  renderStream(
    template: TemplateInput,
    context?: TemplateContext,
    options?: RenderOptions,
  ): ReadableStream<string>;

  /** Rejects queued work and terminates all workers. */
  dispose(): Promise<void>;
}

/** A rendering failure reported by the Rust engine. */
export class NunjitsuRenderError extends Error {
  /** Stable numeric ABI error code for diagnostics. */
  readonly code: number;

  /** Creates an error from a validated worker failure response. */
  constructor(code: number) {
    super(renderErrorMessage(code));
    this.name = 'NunjitsuRenderError';
    this.code = code;
  }
}

/** Creates an engine using entry-point-specific worker and Wasm assets. */
export async function createEngineWithRuntime(
  runtime: RuntimeAssets,
  options: EngineOptions = {},
): Promise<Engine> {
  const pool = normalizePoolOptions(options.workerPool);
  const retainedMemoryBytes = options.retainedMemoryBytes ?? defaultRetainedMemoryBytes;
  if (!Number.isSafeInteger(retainedMemoryBytes) || retainedMemoryBytes < initialMemoryPages * 65_536) {
    throw new RangeError('retainedMemoryBytes must be at least the initial Wasm memory size');
  }

  const engine = new EngineImplementation(
    runtime,
    pool,
    retainedMemoryBytes,
    options.loaders,
    options.autoescape ?? false,
  );
  await engine.initialize();
  return engine;
}

/** Normalized worker bounds used internally by the engine. */
interface NormalizedPoolOptions {
  minWorkers: number;
  maxWorkers: number;
}

/** A queued request waiting for an available worker. */
interface WorkerWaiter {
  resolve: (slot: WorkerSlot) => void;
  reject: (error: Error) => void;
  signal: AbortSignal | undefined;
  abort: (() => void) | undefined;
}

/** One response expected from the worker for an active render. */
interface PendingRender {
  id: number;
  resolve: (output: string) => void;
  reject: (error: Error) => void;
  abort: (() => void) | undefined;
}

/** Message sent after a worker instantiates the Wasm module. */
interface ReadyMessage {
  type: 'ready';
  abiVersion: number;
  arenaBase: number;
}

/** Successful response for a buffered render. */
interface ResultMessage {
  type: 'result';
  id: number;
  state: 1;
  outputOffset: number;
  outputLength: number;
}

/** Failed response for a buffered render. */
interface ErrorMessage {
  type: 'result';
  id: number;
  state: 2;
  errorCode: number;
}

/** Worker response accepted by the host protocol. */
type WorkerMessage = ReadyMessage | ResultMessage | ErrorMessage;

class EngineImplementation implements Engine {
  readonly #runtime: RuntimeAssets;
  readonly #pool: NormalizedPoolOptions;
  readonly #retainedMemoryBytes: number;
  readonly #loaders: readonly TemplateLoader[];
  readonly #autoescape: boolean;
  readonly #slots: WorkerSlot[] = [];
  readonly #waiters: WorkerWaiter[] = [];
  #disposed = false;

  constructor(
    runtime: RuntimeAssets,
    pool: NormalizedPoolOptions,
    retainedMemoryBytes: number,
    loaders: readonly TemplateLoader[] = [],
    autoescape = false,
  ) {
    this.#runtime = runtime;
    this.#pool = pool;
    this.#retainedMemoryBytes = retainedMemoryBytes;
    this.#loaders = Object.freeze([...loaders]);
    this.#autoescape = autoescape;
  }

  async initialize(): Promise<void> {
    const slots = Array.from({ length: this.#pool.minWorkers }, () => this.#addSlot());
    try {
      await Promise.all(slots.map(slot => slot.ready));
    } catch (error) {
      await this.dispose();
      throw error;
    }
  }

  async render(
    template: TemplateInput,
    context: TemplateContext = {},
    options: RenderOptions = {},
  ): Promise<string> {
    this.#assertActive();
    if (options.signal?.aborted) {
      throw abortError();
    }

    const source = await this.#resolveTemplate(template, options.signal);
    const slot = await this.#acquire(options.signal);
    try {
      return await slot.render(source, context, this.#autoescape, options.signal);
    } finally {
      this.#release(slot);
    }
  }

  renderStream(
    template: TemplateInput,
    context: TemplateContext = {},
    options: RenderOptions = {},
  ): ReadableStream<string> {
    let started = false;
    return new ReadableStream<string>({
      pull: async controller => {
        if (started) {
          return;
        }
        started = true;
        try {
          controller.enqueue(await this.render(template, context, options));
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    });
  }

  async dispose(): Promise<void> {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.abort?.();
      waiter.reject(new Error('The Nunjitsu engine was disposed'));
    }
    await Promise.all(this.#slots.splice(0).map(slot => slot.terminate()));
  }

  async #acquire(signal: AbortSignal | undefined): Promise<WorkerSlot> {
    const idle = this.#slots.find(slot => !slot.busy && !slot.failed);
    if (idle) {
      idle.busy = true;
      await idle.ready;
      return idle;
    }
    if (this.#slots.length < this.#pool.maxWorkers) {
      const slot = this.#addSlot();
      slot.busy = true;
      try {
        await slot.ready;
      } catch (error) {
        this.#release(slot);
        throw error;
      }
      return slot;
    }

    return await new Promise<WorkerSlot>((resolve, reject) => {
      const waiter: WorkerWaiter = {
        resolve,
        reject,
        signal,
        abort: undefined,
      };
      if (signal) {
        waiter.abort = () => signal.removeEventListener('abort', onAbort);
        const onAbort = () => {
          const index = this.#waiters.indexOf(waiter);
          if (index !== -1) {
            this.#waiters.splice(index, 1);
          }
          waiter.abort?.();
          reject(abortError());
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
      this.#waiters.push(waiter);
    });
  }

  #release(slot: WorkerSlot): void {
    const shouldRecycle = slot.failed || slot.memory.buffer.byteLength > this.#retainedMemoryBytes;
    if (shouldRecycle) {
      const index = this.#slots.indexOf(slot);
      if (index !== -1) {
        this.#slots.splice(index, 1);
      }
      void slot.terminate();
    } else {
      slot.busy = false;
    }
    this.#dispatch();
    this.#restoreMinimum();
  }

  #dispatch(): void {
    while (this.#waiters.length > 0) {
      let slot = this.#slots.find(candidate => !candidate.busy && !candidate.failed);
      if (!slot && this.#slots.length < this.#pool.maxWorkers) {
        slot = this.#addSlot();
      }
      if (!slot) {
        return;
      }
      const waiter = this.#waiters.shift();
      if (!waiter) {
        return;
      }
      waiter.abort?.();
      slot.busy = true;
      waiter.resolve(slot);
    }
  }

  #restoreMinimum(): void {
    if (this.#disposed) {
      return;
    }
    while (this.#slots.length < this.#pool.minWorkers) {
      const slot = this.#addSlot();
      void slot.ready.catch(() => {
        this.#release(slot);
      });
    }
  }

  #addSlot(): WorkerSlot {
    const slot = new WorkerSlot(this.#runtime);
    this.#slots.push(slot);
    return slot;
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new Error('The Nunjitsu engine was disposed');
    }
  }

  async #resolveTemplate(template: TemplateInput, signal: AbortSignal | undefined): Promise<string> {
    const hasSource = 'source' in template && typeof template.source === 'string';
    const hasName = 'name' in template && typeof template.name === 'string';
    if (hasSource === hasName) {
      throw new TypeError('A template must provide exactly one string source or name');
    }
    if (hasSource) {
      return template.source;
    }
    if (hasName) {
      return (await loadTemplate(this.#loaders, template.name, signal)).source;
    }
    throw new TypeError('Invalid template input');
  }
}

class WorkerSlot {
  readonly memory: WebAssembly.Memory;
  readonly ready: Promise<void>;
  busy = false;
  failed = false;

  readonly #worker: Worker;
  #arenaBase = 0;
  #nextRenderId = 1;
  #pending: PendingRender | undefined;
  #resolveReady: (() => void) | undefined;
  #rejectReady: ((error: Error) => void) | undefined;
  #closed = false;

  constructor(runtime: RuntimeAssets) {
    this.memory = new WebAssembly.Memory({
      initial: initialMemoryPages,
      maximum: maximumMemoryPages,
      shared: true,
    });
    this.ready = new Promise<void>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    this.#worker = new Worker(runtime.workerUrl, {
      workerData: {
        memory: this.memory,
        wasmUrl: runtime.wasmUrl.href,
      },
    });
    this.#worker.on('message', message => this.#handleMessage(message));
    this.#worker.on('error', error => this.#fail(error));
    this.#worker.on('exit', code => {
      if (!this.#closed && code !== 0) {
        this.#fail(new Error(`Nunjitsu worker exited with code ${code}`));
      }
    });
  }

  async render(
    source: string,
    context: TemplateContext,
    autoescape: boolean,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    await this.ready;
    if (this.failed || this.#closed) {
      throw new Error('The Nunjitsu worker is unavailable');
    }
    if (signal?.aborted) {
      throw abortError();
    }
    if (this.#pending) {
      throw new Error('The Nunjitsu worker already has an active render');
    }

    const encoded = new ArenaWriter(this.memory, this.#arenaBase).encodeRender(source, context, {
      autoescape,
    });
    const id = this.#nextRenderId++;
    return await new Promise<string>((resolve, reject) => {
      const pending: PendingRender = { id, resolve, reject, abort: undefined };
      if (signal) {
        const onAbort = () => {
          pending.abort?.();
          this.#pending = undefined;
          this.failed = true;
          void this.#worker.terminate();
          reject(abortError());
        };
        pending.abort = () => signal.removeEventListener('abort', onAbort);
        signal.addEventListener('abort', onAbort, { once: true });
      }
      this.#pending = pending;
      this.#worker.postMessage({
        type: 'render',
        id,
        requestOffset: encoded.requestOffset,
        cursor: encoded.cursor,
      });
    });
  }

  async terminate(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.failed = true;
    const error = new Error('The Nunjitsu worker was terminated');
    this.#rejectReady?.(error);
    this.#pending?.abort?.();
    this.#pending?.reject(error);
    this.#pending = undefined;
    await this.#worker.terminate();
  }

  #handleMessage(value: unknown): void {
    if (!isWorkerMessage(value)) {
      this.#fail(new Error('Nunjitsu worker returned an invalid message'));
      return;
    }
    if (value.type === 'ready') {
      if (value.abiVersion !== 3 || value.arenaBase <= 0) {
        this.#fail(new Error('Nunjitsu worker reported an incompatible Wasm ABI'));
        return;
      }
      this.#arenaBase = value.arenaBase;
      this.#resolveReady?.();
      this.#resolveReady = undefined;
      this.#rejectReady = undefined;
      return;
    }

    const pending = this.#pending;
    if (!pending) {
      this.#fail(new Error('Nunjitsu worker returned an unexpected render result'));
      return;
    }
    if (value.id !== pending.id) {
      this.#fail(new Error('Nunjitsu worker returned a stale render result'));
      return;
    }
    pending.abort?.();
    this.#pending = undefined;
    if (value.state === 1) {
      try {
        pending.resolve(decodeOutput(this.memory, value.outputOffset, value.outputLength));
      } catch (error) {
        pending.reject(asError(error));
      }
    } else {
      pending.reject(new NunjitsuRenderError(value.errorCode));
    }
  }

  #fail(error: Error): void {
    this.failed = true;
    this.#rejectReady?.(error);
    this.#rejectReady = undefined;
    this.#resolveReady = undefined;
    this.#pending?.abort?.();
    this.#pending?.reject(error);
    this.#pending = undefined;
  }
}

function normalizePoolOptions(options: WorkerPoolOptions | undefined): NormalizedPoolOptions {
  const minWorkers = options?.minWorkers ?? 1;
  const maxWorkers = options?.maxWorkers ?? availableParallelism();
  if (!Number.isSafeInteger(minWorkers) || minWorkers < 1) {
    throw new RangeError('minWorkers must be a positive integer');
  }
  if (!Number.isSafeInteger(maxWorkers) || maxWorkers < minWorkers) {
    throw new RangeError('maxWorkers must be an integer greater than or equal to minWorkers');
  }
  return { minWorkers, maxWorkers };
}

function isWorkerMessage(value: unknown): value is WorkerMessage {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const message = value as Record<string, unknown>;
  if (message.type === 'ready') {
    return typeof message.abiVersion === 'number' && typeof message.arenaBase === 'number';
  }
  if (message.type !== 'result' || typeof message.id !== 'number') {
    return false;
  }
  if (message.state === 1) {
    return typeof message.outputOffset === 'number' && typeof message.outputLength === 'number';
  }
  return message.state === 2 && typeof message.errorCode === 'number';
}

function renderErrorMessage(code: number): string {
  if (code === 3) {
    return 'Unclosed template interpolation';
  }
  if (code === 4) {
    return 'Rendered output exceeds the available Wasm memory';
  }
  return `Nunjitsu rendering failed with ABI error code ${code}`;
}

function abortError(): Error {
  const error = new Error('The Nunjitsu render was aborted');
  error.name = 'AbortError';
  return error;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
