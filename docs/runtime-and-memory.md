# Runtime and memory

## Worker model

Nunjitsu runs the Rust/Wasm engine only in Node worker threads. The engine uses
a configurable lazy pool:

- `createEngine` compiles or loads the Wasm module and starts the configured
  minimum worker count, initially one by default;
- queue pressure may grow the pool up to its configured maximum;
- each worker accepts one render at a time, including time suspended on an
  asynchronous capability; and
- healthy workers remain available until explicit engine disposal.

Workers do not share memory with each other. Each worker owns a shared
`WebAssembly.Memory` visible to the Node main thread and its Wasm instance. This
avoids cross-worker allocator contention and limits the failure domain of arena
corruption. Concurrent renders may temporarily duplicate template sources
across workers; no source survives the render that loaded it.

## Raw Wasm ABI

The host contract is a small, versioned raw ABI. Imports and exports use numeric
primitives and offset/length pairs. Structured objects do not cross the ABI.

In addition to the worker-owned memory, the production module imports two
worker-local scalar operations required by Nunjucks semantics: bounded random
index selection and JavaScript regular-expression replacement over validated
UTF-8 ranges. Rust owns the source parsing, typed regex record, arena
allocation, and result validation. The worker import cannot retain an arena
view or offset after returning.

The ABI must:

- expose and validate an explicit version before rendering;
- return explicit states such as progress, output available, capability yield,
  completion, cancellation, and error;
- reject invalid offsets, lengths, record kinds, state transitions, and integer
  overflow before reading arena data; and
- fail deterministically when the TypeScript host and Wasm artifact do not
  match.

The npm package ships its TypeScript host and Wasm artifact together. The ABI
version detects accidental mismatches; it is not a public third-party extension
API.

## One heterogeneous arena

All render data lives in one heterogeneous byte arena inside the worker's
linear memory. This includes loaded UTF-8 sources, compact syntax records,
deferred AST bodies, safe input values, evaluator frames, capability payloads,
and output chunks.

Built-in `cycler` and `joiner` globals use small typed mutable arena records.
Their cursors are render-local state, are reachable only through template
scope, and disappear with the wholesale arena reset. They never become host
objects or persistent engine state.

Arena invariants are non-negotiable:

- Records have an explicit kind, byte length, and alignment.
- References are bounded integer byte offsets, never Rust or host pointers.
- Variable-length data is referenced by offset and length within the same
  arena.
- Readers validate the complete record before interpreting its payload.
- Mutable evaluator state has one owner at a time.
- An offset is valid only for its render epoch and must never escape through
  the public API.

A small fixed control header may coordinate ABI state, but it must not become a
second object graph or an alternate payload store.

## Parse and evaluation pipeline

Nunjitsu does not build and retain a complete AST by default. The parser emits
ordinary nodes to the evaluator as soon as their syntax is validated. Arena
checkpoints allow consumed transient records to be reclaimed where stack and
reference safety permit.

Some constructs are semantically deferred. Macros, inheritance blocks, loop
bodies, callback bodies, and other repeatedly or subsequently evaluated regions
retain compact AST records until they are no longer reachable in the current
render. Every source region is syntax-validated during its initial pass; the
engine must not hide syntax errors merely because a branch or macro was unused.

Includes and inheritance are loaded on demand. Within one render, canonical
template identities prevent duplicate loading and enable cycle detection. No
parsed form, dependency graph, or raw source is retained for another render.
An extending template contributes compact block definitions in child-first
resolution order. Selected overrides execute through bounded source frames, so
inheritance does not require copying block bodies or retaining a precompiled
template graph. Each active override receives a render-local `super` callable
linked to the next matching definition and ultimately the parent body; invoking
it uses the same captured, resumable frame path as a macro call. Every block
runs behind the pre-block scope boundary: parent globals remain readable, while
assignments in child, parent, standalone, and `super` bodies cannot mutate the
calling scope.

Imports materialize a render-local namespace record containing exported values
and deferred macro definitions. `from` imports bind selected namespace entries
into the active scope. Context-enabled imports begin from the caller scope;
context-free imports begin from an empty local scope. Nested loop and block
scopes remain isolated from both the namespace and the importer.

## Suspension and resumption

Evaluation uses explicit frames rather than the native Rust stack as its
durable state. When a loader, filter, test, global, or extension renderer needs
host work, the engine records a continuation in the arena and yields through
the ABI. The main thread dispatches the trusted callback, encodes its result,
and asks the worker to resume that continuation.

This design must support cancellation and deterministic budget accounting at
every yield boundary. It must not use `Atomics.wait` to hide asynchronous host
work or rely on Asyncify-style stack transformation.

## Output

Buffered rendering accumulates bounded UTF-8 output and resolves atomically to
one JavaScript string. Streaming rendering uses bounded chunks and pauses the
evaluator until the consumer's `ReadableStream` requests more data. The decoder
must preserve UTF-8 code points across chunk boundaries.

Captured bodies, including block assignments and macro output, push an
arena-backed output sink. Nested sinks retain their parent chunk chain and byte
count, never expose captured chunks to a streaming consumer, and restore the
parent sink before assigning the captured string. Capture failure follows the
same render-wide cleanup path as ordinary output failure.

A streaming consumer may observe earlier chunks before a later error. That is
part of the streaming contract and must be documented in the public API.

## Reset and reclamation

Completion, failure, and cancellation all run the same render cleanup:

1. invalidate the render epoch;
2. clear capability and continuation state;
3. reset arena cursors and logical lengths; and
4. verify that the worker is safe to return to the pool.

Normal backing capacity may be reused. Wasm linear memory cannot shrink, so an
engine-configured retained-memory threshold controls high-water retention. A
worker that grows beyond the threshold finishes cleanup and is then terminated
and recreated from the already compiled module.
