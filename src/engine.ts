import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';

import {
  createCapabilityRegistry,
  type CapabilityKind,
  type CapabilityDescriptors,
  type CapabilityRegistry,
  type TemplateCapabilities,
} from './capabilities.ts';
import { loadTemplate, type LoadedTemplate, type TemplateLoader } from './loaders.ts';
import {
  NunjitsuLimitError,
  normalizeRenderLimits,
  type NormalizedRenderLimits,
  type RenderLimits,
} from './limits.ts';
import { ArenaWriter, decodeCapabilityRequest, decodeOutput } from './protocol.ts';
import type { TemplateContext, TemplateValue } from './values.ts';

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
export interface EngineOptions extends TemplateCapabilities {
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
  /** Finite defaults may be tightened or explicitly set to `Infinity`. */
  limits?: Partial<RenderLimits>;
}

/** An initialized asynchronous Nunjitsu engine. */
export interface Engine {
  /** Compiles and renders an inline or explicitly loaded template to one buffered string. */
  render(
    template: TemplateInput,
    context?: TemplateContext,
    options?: RenderOptions,
  ): Promise<string>;

  /**
   * Compiles and renders through a pull-driven Web stream. UTF-8-safe chunks are at most 64 KiB,
   * and a later failure may reject the stream after earlier chunks were consumed.
   */
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
    options.loaders ?? [],
    options.autoescape ?? false,
    createCapabilityRegistry(options),
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

/** State shared by buffered and streaming renders assigned to one worker. */
interface PendingRenderBase {
  id: number;
  abort: (() => void) | undefined;
  load: (name: string) => Promise<LoadedTemplate>;
  call: (
    kind: CapabilityKind,
    id: number,
    arguments_: readonly TemplateValue[],
  ) => Promise<TemplateValue>;
  loading: boolean;
  calling: boolean;
  loadedByName: Map<string, CachedLoadedTemplate>;
  loadedByCanonicalName: Map<string, CachedLoadedTemplate>;
}

/** Buffered render waiting for one terminal output value. */
interface PendingBufferedRender extends PendingRenderBase {
  kind: 'buffered';
  resolve: (output: string) => void;
  reject: (error: Error) => void;
}

/** Resolver for one consumer pull against a suspended streaming render. */
interface StreamWaiter {
  resolve: (result: IteratorResult<string>) => void;
  reject: (error: Error) => void;
}

/** Streaming render retained while output is suspended on backpressure. */
interface PendingStreamingRender extends PendingRenderBase {
  kind: 'streaming';
  chunk: string | undefined;
  needsResume: boolean;
  done: boolean;
  error: Error | undefined;
  waiter: StreamWaiter | undefined;
  resolveFinished: () => void;
  rejectFinished: (error: Error) => void;
}

/** One active render assigned to a worker. */
type PendingRender = PendingBufferedRender | PendingStreamingRender;

/** Immutable arena offsets for a source already loaded during this render. */
interface CachedLoadedTemplate {
  sourceOffset: number;
  canonicalOffset: number;
}

/** Entry source and optional canonical identity passed into one render. */
interface ResolvedTemplate {
  source: string;
  canonicalName?: string;
  loaderCalls: number;
}

/** Message sent after a worker instantiates the Wasm module. */
interface ReadyMessage {
  type: 'ready';
  abiVersion: number;
  arenaBase: number;
}

/** Successful terminal response for a render. */
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

/** Loader request yielded by the resumable Rust evaluator. */
interface LoadMessage {
  type: 'load';
  id: number;
  name: string;
  cursor: number;
}

/** Output chunk yielded while a streaming evaluator is suspended. */
interface ChunkMessage {
  type: 'chunk';
  id: number;
  chunk: string;
}

/** Trusted host capability request yielded by expression evaluation. */
interface CapabilityMessage {
  type: 'capability';
  id: number;
  requestOffset: number;
  requestLength: number;
  cursor: number;
}

/** Worker response accepted by the host protocol. */
type WorkerMessage =
  | ReadyMessage
  | ResultMessage
  | ErrorMessage
  | LoadMessage
  | ChunkMessage
  | CapabilityMessage;

class EngineImplementation implements Engine {
  readonly #runtime: RuntimeAssets;
  readonly #pool: NormalizedPoolOptions;
  readonly #retainedMemoryBytes: number;
  readonly #loaders: readonly TemplateLoader[];
  readonly #autoescape: boolean;
  readonly #capabilities: CapabilityRegistry;
  readonly #slots: WorkerSlot[] = [];
  readonly #waiters: WorkerWaiter[] = [];
  #disposed = false;

  constructor(
    runtime: RuntimeAssets,
    pool: NormalizedPoolOptions,
    retainedMemoryBytes: number,
    loaders: readonly TemplateLoader[],
    autoescape: boolean,
    capabilities: CapabilityRegistry,
  ) {
    this.#runtime = runtime;
    this.#pool = pool;
    this.#retainedMemoryBytes = retainedMemoryBytes;
    this.#loaders = Object.freeze([...loaders]);
    this.#autoescape = autoescape;
    this.#capabilities = capabilities;
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
    const cancellation = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([options.signal, cancellation.signal])
      : cancellation.signal;
    let slot: WorkerSlot | undefined;
    try {
      if (signal.aborted) {
        throw abortError();
      }
      const limits = normalizeRenderLimits(options.limits);
      const resolved = await this.#resolveTemplate(template, limits, signal);
      const workerLimits: NormalizedRenderLimits = Object.freeze({
        ...limits,
        loaderCalls:
          limits.loaderCalls === Number.POSITIVE_INFINITY
            ? limits.loaderCalls
            : limits.loaderCalls - resolved.loaderCalls,
      });
      slot = await this.#acquire(signal);
      return await slot.render(
        resolved,
        context,
        this.#autoescape,
        this.#capabilities.descriptors,
        workerLimits,
        name => loadTemplate(this.#loaders, name, signal),
        (kind, id, arguments_) => this.#capabilities.invoke(kind, id, arguments_, signal),
        signal,
      );
    } finally {
      cancellation.abort();
      if (slot) {
        this.#release(slot);
      }
    }
  }

  renderStream(
    template: TemplateInput,
    context: TemplateContext = {},
    options: RenderOptions = {},
  ): ReadableStream<string> {
    const cancellation = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([options.signal, cancellation.signal])
      : cancellation.signal;
    let sessionPromise: Promise<WorkerStreamSession> | undefined;
    const getSession = () => {
      sessionPromise ??= this.#startStreaming(
        template,
        context,
        options.limits,
        signal,
        () => cancellation.abort(),
      );
      return sessionPromise;
    };

    return new ReadableStream<string>({
      pull: async controller => {
        try {
          const result = await (await getSession()).next();
          if (result.done) {
            controller.close();
          } else {
            controller.enqueue(result.value);
          }
        } catch (error) {
          controller.error(error);
        }
      },
      cancel: async () => {
        cancellation.abort();
        if (sessionPromise) {
          const session = await sessionPromise.catch(() => undefined);
          session?.cancel();
        }
      },
    });
  }

  async #startStreaming(
    template: TemplateInput,
    context: TemplateContext,
    requestedLimits: Partial<RenderLimits> | undefined,
    signal: AbortSignal,
    cancel: () => void,
  ): Promise<WorkerStreamSession> {
    this.#assertActive();
    if (signal.aborted) {
      throw abortError();
    }

    const limits = normalizeRenderLimits(requestedLimits);
    const resolved = await this.#resolveTemplate(template, limits, signal);
    const workerLimits: NormalizedRenderLimits = Object.freeze({
      ...limits,
      loaderCalls:
        limits.loaderCalls === Number.POSITIVE_INFINITY
          ? limits.loaderCalls
          : limits.loaderCalls - resolved.loaderCalls,
    });
    const slot = await this.#acquire(signal);
    try {
      const session = await slot.renderStream(
        resolved,
        context,
        this.#autoescape,
        this.#capabilities.descriptors,
        workerLimits,
        name => loadTemplate(this.#loaders, name, signal),
        (kind, id, arguments_) => this.#capabilities.invoke(kind, id, arguments_, signal),
        signal,
      );
      void session.finished.then(
        () => {
          cancel();
          this.#release(slot);
        },
        () => {
          cancel();
          this.#release(slot);
        },
      );
      return session;
    } catch (error) {
      this.#release(slot);
      throw error;
    }
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

  async #resolveTemplate(
    template: TemplateInput,
    limits: NormalizedRenderLimits,
    signal: AbortSignal | undefined,
  ): Promise<ResolvedTemplate> {
    const hasSource = 'source' in template && typeof template.source === 'string';
    const hasName = 'name' in template && typeof template.name === 'string';
    if (hasSource === hasName) {
      throw new TypeError('A template must provide exactly one string source or name');
    }
    if (hasSource) {
      return { source: template.source, loaderCalls: 0 };
    }
    if (hasName) {
      if (limits.loaderCalls === 0) {
        throw new NunjitsuLimitError('loaderCalls');
      }
      return {
        ...(await loadTemplate(this.#loaders, template.name, signal)),
        loaderCalls: 1,
      };
    }
    throw new TypeError('Invalid template input');
  }
}

/** Pull-facing handle for one worker-resident streaming render. */
class WorkerStreamSession {
  readonly finished: Promise<void>;
  readonly #slot: WorkerSlot;
  readonly #pending: PendingStreamingRender;

  constructor(
    slot: WorkerSlot,
    pending: PendingStreamingRender,
    finished: Promise<void>,
  ) {
    this.#slot = slot;
    this.#pending = pending;
    this.finished = finished;
  }

  next(): Promise<IteratorResult<string>> {
    return this.#slot.nextStream(this.#pending);
  }

  cancel(): void {
    this.#slot.cancelStream(this.#pending);
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
    template: ResolvedTemplate,
    context: TemplateContext,
    autoescape: boolean,
    capabilities: CapabilityDescriptors,
    limits: NormalizedRenderLimits,
    load: (name: string) => Promise<LoadedTemplate>,
    call: (
      kind: CapabilityKind,
      id: number,
      arguments_: readonly TemplateValue[],
    ) => Promise<TemplateValue>,
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

    const encoded = new ArenaWriter(this.memory, this.#arenaBase).encodeRender(
      template.source,
      context,
      {
        autoescape,
        streaming: false,
        capabilities,
        limits,
        ...(template.canonicalName ? { canonicalName: template.canonicalName } : {}),
      },
    );
    if (
      limits.arenaBytes !== Number.POSITIVE_INFINITY &&
      encoded.cursor - this.#arenaBase > limits.arenaBytes
    ) {
      throw new NunjitsuLimitError('arenaBytes');
    }
    const id = this.#nextRenderId++;
    return await new Promise<string>((resolve, reject) => {
      const pending: PendingBufferedRender = {
        kind: 'buffered',
        id,
        resolve,
        reject,
        abort: undefined,
        load,
        call,
        loading: false,
        calling: false,
        loadedByName: new Map(),
        loadedByCanonicalName: new Map(),
      };
      if (signal) {
        const onAbort = () => {
          this.#abortRender(pending, abortError());
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

  async renderStream(
    template: ResolvedTemplate,
    context: TemplateContext,
    autoescape: boolean,
    capabilities: CapabilityDescriptors,
    limits: NormalizedRenderLimits,
    load: (name: string) => Promise<LoadedTemplate>,
    call: (
      kind: CapabilityKind,
      id: number,
      arguments_: readonly TemplateValue[],
    ) => Promise<TemplateValue>,
    signal: AbortSignal | undefined,
  ): Promise<WorkerStreamSession> {
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

    const encoded = new ArenaWriter(this.memory, this.#arenaBase).encodeRender(
      template.source,
      context,
      {
        autoescape,
        streaming: true,
        capabilities,
        limits,
        ...(template.canonicalName ? { canonicalName: template.canonicalName } : {}),
      },
    );
    if (
      limits.arenaBytes !== Number.POSITIVE_INFINITY &&
      encoded.cursor - this.#arenaBase > limits.arenaBytes
    ) {
      throw new NunjitsuLimitError('arenaBytes');
    }

    let resolveFinished: () => void = () => undefined;
    let rejectFinished: (error: Error) => void = () => undefined;
    const finished = new Promise<void>((resolve, reject) => {
      resolveFinished = resolve;
      rejectFinished = reject;
    });
    const pending: PendingStreamingRender = {
      kind: 'streaming',
      id: this.#nextRenderId++,
      abort: undefined,
      load,
      call,
      loading: false,
      calling: false,
      loadedByName: new Map(),
      loadedByCanonicalName: new Map(),
      chunk: undefined,
      needsResume: false,
      done: false,
      error: undefined,
      waiter: undefined,
      resolveFinished,
      rejectFinished,
    };
    if (signal) {
      const onAbort = () => {
        this.#abortRender(pending, abortError());
      };
      pending.abort = () => signal.removeEventListener('abort', onAbort);
      signal.addEventListener('abort', onAbort, { once: true });
    }
    this.#pending = pending;
    this.#worker.postMessage({
      type: 'render',
      id: pending.id,
      requestOffset: encoded.requestOffset,
      cursor: encoded.cursor,
    });
    return new WorkerStreamSession(this, pending, finished);
  }

  nextStream(pending: PendingStreamingRender): Promise<IteratorResult<string>> {
    if (pending.error) {
      return Promise.reject(pending.error);
    }
    if (pending.chunk !== undefined) {
      const chunk = pending.chunk;
      pending.chunk = undefined;
      return Promise.resolve({ value: chunk, done: false });
    }
    if (pending.done) {
      return Promise.resolve({ value: undefined, done: true });
    }
    if (pending.waiter) {
      return Promise.reject(new Error('Concurrent pulls are not supported'));
    }

    return new Promise<IteratorResult<string>>((resolve, reject) => {
      pending.waiter = { resolve, reject };
      if (pending.needsResume) {
        pending.needsResume = false;
        this.#worker.postMessage({ type: 'resumeOutput', id: pending.id });
      }
    });
  }

  cancelStream(pending: PendingStreamingRender): void {
    if (!pending.done && !pending.error) {
      this.#abortRender(pending, abortError());
    }
  }

  async terminate(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.failed = true;
    const error = new Error('The Nunjitsu worker was terminated');
    this.#rejectReady?.(error);
    if (this.#pending) {
      this.#rejectPending(this.#pending, error);
    }
    this.#pending = undefined;
    await this.#worker.terminate();
  }

  #handleMessage(value: unknown): void {
    if (!isWorkerMessage(value)) {
      this.#fail(new Error('Nunjitsu worker returned an invalid message'));
      return;
    }
    if (value.type === 'ready') {
      if (value.abiVersion !== 9 || value.arenaBase <= 0) {
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
    if (value.type === 'load') {
      if (pending.loading || pending.calling) {
        this.#fail(new Error('Nunjitsu worker yielded overlapping host requests'));
        return;
      }
      pending.loading = true;
      void this.#resumeLoad(pending, value);
      return;
    }
    if (value.type === 'capability') {
      if (pending.loading || pending.calling) {
        this.#fail(new Error('Nunjitsu worker yielded overlapping host requests'));
        return;
      }
      pending.calling = true;
      void this.#resumeCapability(pending, value);
      return;
    }
    if (value.type === 'chunk') {
      if (pending.kind !== 'streaming' || pending.chunk !== undefined || pending.needsResume) {
        this.#fail(new Error('Nunjitsu worker yielded an unexpected output chunk'));
        return;
      }
      pending.chunk = value.chunk;
      pending.needsResume = true;
      this.#notifyStream(pending);
      return;
    }

    if (value.state === 1) {
      pending.abort?.();
      pending.abort = undefined;
      this.#pending = undefined;
      if (pending.kind === 'streaming') {
        if (value.outputOffset !== 0 || value.outputLength !== 0) {
          this.#rejectPending(
            pending,
            new Error('Nunjitsu streaming render returned buffered output'),
          );
          this.failed = true;
          void this.#worker.terminate();
          return;
        }
        pending.done = true;
        pending.resolveFinished();
        this.#notifyStream(pending);
      } else {
        try {
          pending.resolve(decodeOutput(this.memory, value.outputOffset, value.outputLength));
        } catch (error) {
          pending.reject(asError(error));
        }
      }
    } else {
      this.#pending = undefined;
      this.#rejectPending(
        pending,
        value.errorCode === 7
          ? new NunjitsuLimitError()
          : new NunjitsuRenderError(value.errorCode),
      );
    }
  }

  #fail(error: Error): void {
    this.failed = true;
    this.#rejectReady?.(error);
    this.#rejectReady = undefined;
    this.#resolveReady = undefined;
    if (this.#pending) {
      this.#rejectPending(this.#pending, error);
    }
    this.#pending = undefined;
  }

  async #resumeLoad(pending: PendingRender, message: LoadMessage): Promise<void> {
    try {
      let cached = pending.loadedByName.get(message.name);
      let cursor = message.cursor;
      if (!cached) {
        const loaded = await pending.load(message.name);
        cached = pending.loadedByCanonicalName.get(loaded.canonicalName);
        if (!cached) {
          const encoded = new ArenaWriter(this.memory, message.cursor).encodeLoadedTemplate(
            loaded.source,
            loaded.canonicalName,
          );
          cached = {
            sourceOffset: encoded.sourceOffset,
            canonicalOffset: encoded.canonicalOffset,
          };
          cursor = encoded.cursor;
          pending.loadedByCanonicalName.set(loaded.canonicalName, cached);
        }
        pending.loadedByName.set(message.name, cached);
      }
      if (this.#pending !== pending || this.failed || this.#closed) {
        return;
      }
      pending.loading = false;
      this.#worker.postMessage({
        type: 'resumeLoad',
        id: pending.id,
        sourceOffset: cached.sourceOffset,
        canonicalOffset: cached.canonicalOffset,
        cursor,
      });
    } catch (error) {
      if (this.#pending !== pending) {
        return;
      }
      this.#pending = undefined;
      this.failed = true;
      void this.#worker.terminate();
      this.#rejectPending(pending, asError(error));
    }
  }

  async #resumeCapability(
    pending: PendingRender,
    message: CapabilityMessage,
  ): Promise<void> {
    try {
      const request = decodeCapabilityRequest(
        this.memory,
        message.requestOffset,
        message.requestLength,
      );
      const result = await pending.call(
        request.kind,
        request.capabilityId,
        request.arguments,
      );
      const encoded = new ArenaWriter(this.memory, message.cursor).encodeCapabilityResult(result);
      if (this.#pending !== pending || this.failed || this.#closed) {
        return;
      }
      pending.calling = false;
      this.#worker.postMessage({
        type: 'resumeCapability',
        id: pending.id,
        valueOffset: encoded.valueOffset,
        cursor: encoded.cursor,
      });
    } catch (error) {
      if (this.#pending !== pending) {
        return;
      }
      this.#pending = undefined;
      this.failed = true;
      void this.#worker.terminate();
      this.#rejectPending(pending, asError(error));
    }
  }

  #abortRender(pending: PendingRender, error: Error): void {
    if (this.#pending !== pending) {
      return;
    }
    this.#pending = undefined;
    this.failed = true;
    this.#rejectPending(pending, error);
    void this.#worker.terminate();
  }

  #rejectPending(pending: PendingRender, error: Error): void {
    pending.abort?.();
    pending.abort = undefined;
    if (pending.kind === 'buffered') {
      pending.reject(error);
      return;
    }
    if (pending.done || pending.error) {
      return;
    }
    pending.error = error;
    pending.rejectFinished(error);
    this.#notifyStream(pending);
  }

  #notifyStream(pending: PendingStreamingRender): void {
    const waiter = pending.waiter;
    if (!waiter) {
      return;
    }
    if (pending.error) {
      pending.waiter = undefined;
      waiter.reject(pending.error);
      return;
    }
    if (pending.chunk !== undefined) {
      const chunk = pending.chunk;
      pending.chunk = undefined;
      pending.waiter = undefined;
      waiter.resolve({ value: chunk, done: false });
      return;
    }
    if (pending.done) {
      pending.waiter = undefined;
      waiter.resolve({ value: undefined, done: true });
    }
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
  if (message.type === 'load') {
    return (
      typeof message.id === 'number' &&
      typeof message.name === 'string' &&
      typeof message.cursor === 'number'
    );
  }
  if (message.type === 'chunk') {
    return typeof message.id === 'number' && typeof message.chunk === 'string';
  }
  if (message.type === 'capability') {
    return (
      typeof message.id === 'number' &&
      typeof message.requestOffset === 'number' &&
      typeof message.requestLength === 'number' &&
      typeof message.cursor === 'number'
    );
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
  if (code === 5) {
    return 'Unsupported or invalid template tag';
  }
  if (code === 6) {
    return 'Template include cycle detected';
  }
  if (code === 8) {
    return 'Template requested an unknown host capability';
  }
  if (code === 9) {
    return 'Invalid or unsupported template expression';
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
