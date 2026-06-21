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
`WebAssembly.Memory` backed by a `SharedArrayBuffer` visible to the Node main
thread and its Wasm instance. The engine selects immutable capacities before
creating the worker and allocates the complete memory once. Rendering never
calls `memory.grow`. Concurrent renders may temporarily duplicate template
sources across workers; no source or host string handle survives the render
that loaded it.

## Raw Wasm ABI

The host contract is a small, versioned raw ABI. Imports and exports use numeric
primitives, slot indices, typed ranges, and frozen logical cursors. Structured
JavaScript objects do not cross the ABI.

The host may write sources, context values, capability results, and registry
data directly into ABI-reserved shared ranges while Rust is idle or suspended.
Rust validates every submitted slot, type mask, index, range, cursor, and
ownership transition before freezing the input and resuming evaluation.

The production module also imports worker-local scalar operations required by
Nunjucks semantics, including bounded random index selection. JavaScript string
and regular-expression behavior is represented in a render-local lazy host
string graph described below rather than by copying generated text into Wasm.

The ABI must:

- expose and validate an explicit version before rendering;
- return explicit states such as progress, output available, capability yield,
  completion, cancellation, and error;
- reject invalid slot indices, ranges, type IDs, masks, state transitions, and
  integer overflow before reading shared data; and
- fail deterministically when the TypeScript host and Wasm artifact do not
  match.

The npm package ships its TypeScript host and Wasm artifact together. The ABI
version detects accidental mismatches; it is not a public third-party extension
API.

## Fixed shared-memory layout

Each worker's linear memory has a versioned fixed layout. The exact offsets and
capacities are recorded in the singleton prefix and validated against the ABI
version at startup:

1. a fixed prefix containing ABI control, render state, render epoch, pool
   offsets, capacities, and logical cursors;
2. one fixed-width repeated-entity slot array;
3. fixed UTF-16 source and input code-unit arrays;
4. a fixed member/index array for collection entries and variable-length
   relationships;
5. fixed command and query arrays for the host string graph;
6. a fixed circular array of output range descriptors; and
7. a fixed-capacity scratch byte pool for temporary UTF-8 materialization.

The prefix owns singleton state. A large render-state structure must never
inflate the repeated slot width. The slot width is instead the smallest aligned
layout that fits the largest repeated logical entity after its fields have been
reduced to appropriate `u8`, `u16`, `u32`, `f64`, index, and range
representations. Repeated entities do not use extension slots.

Every repeated slot starts with one 32-bit word. Eight bits contain the concrete
type ID and 24 bits contain orthogonal category and state masks. If the entity
inventory ever exceeds 256 concrete types, an ABI revision may move to a 16-bit
type/16-bit mask split; it must not silently reinterpret an existing layout.
The remaining slot fields contain only numeric values, slot indices, typed
ranges, masks, and flags. Text and variable-length payloads are never inline.

Slot index zero is null. All other references are bounded `u32` indices into
the universal slot array. Slots are allocated monotonically and are never
reused during a render. Capacity exhaustion is a deterministic resource error;
it does not grow memory or fall back to a variable record allocator.

The public engine provides a balanced default capacity profile and immutable
advanced overrides for at least repeated slots, UTF-16 source/input code units,
members/indices, string operations, string queries, and output descriptors.
Per-render limits may be lower than worker capacity but cannot enlarge it.
Scratch allocation is cursor-based inside its preallocated pool and is rewound
at defined continuation and output boundaries. Scratch bytes never contain
durable entities or references that survive those boundaries.

## Parse and evaluation pipeline

Nunjitsu does not build and retain a complete AST by default. The parser
consumes ordinary nodes directly from immutable UTF-16 source ranges and emits
them to the evaluator as soon as their syntax is validated.

Some constructs are semantically deferred. Macros, inheritance blocks, loop
bodies, callback bodies, and other repeatedly or subsequently evaluated regions
retain compact slots containing source indices and UTF-16 ranges until the
render ends. Every source region is syntax-validated during its initial pass;
the engine must not hide syntax errors merely because a branch or macro was
unused.

Includes, imports, and inheritance are loaded on demand. Load-yield state
contains the evaluated dependency name and the current source frame's canonical
identity. Canonical identity is propagated through block, macro, `super`, and
custom-tag body frames so a relative request always resolves from the source
that contains it rather than the source that happened to call it.

Within one render, the request cache is keyed by canonical parent plus requested
name, while loaded source ranges are deduplicated by their resolved canonical
identity. This prevents `./partial.njk` in two directories from aliasing while
still sharing two spellings that resolve to the same source. No
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

Imports materialize a render-local namespace slot and member range containing
exported values and deferred macro definitions. `from` imports bind selected
namespace entries into the active scope. Context-enabled imports begin from the
caller scope; context-free imports begin from an empty local scope. Nested loop
and block scopes remain isolated from both the namespace and the importer.

## Lazy host strings

The worker host owns a render-local table of JavaScript strings. Original
template sources, context strings, callback results, and computed strings
receive deterministic `u32` handles allocated by Wasm. A string value in a slot
is a handle plus a UTF-16 start and length; the range therefore maps directly to
JavaScript string slicing semantics.

Computed string operations are lazy. Wasm appends commands such as concatenate,
escape, slice, format, or regular-expression replacement to a bounded command
array and assigns the result handle before JavaScript evaluates it. Later
operations and output may reference the whole handle or a subrange, allowing
Wasm to continue without copying or waiting for the generated text.

When template control flow needs an answer that depends on a lazy string—such
as equality, ordering, membership, truthiness, length, or a computed dependency
name—Wasm yields an explicit query barrier. JavaScript resolves only the needed
part of the operation graph and returns the smallest scalar, range metadata, or
UTF-16 code-unit sequence required to resume. Pure output composition does not
create a query barrier.

All handles and commands are scoped to one render epoch. The host validates
operation kinds, argument handles, ranges, limits, and ownership before adding
them to its graph, and discards the complete table during render cleanup.

## Suspension and resumption

Evaluation uses explicit indexed slots rather than the native Rust stack as its
durable state. When a loader, filter, test, global, extension renderer, or string
query needs host work, the engine records a continuation slot and yields through
the ABI. The main thread dispatches the work, encodes its result directly into
reserved slots and typed arrays, and asks the worker to resume that continuation.

This design must support cancellation and deterministic budget accounting at
every yield boundary. It must not use `Atomics.wait` to hide asynchronous host
work or rely on Asyncify-style stack transformation.

## Output

Wasm does not copy rendered text back to JavaScript. It appends fixed-size
descriptors containing a host string handle and UTF-16 start/length range to a
circular output array. When that array fills, Wasm yields; JavaScript drains the
descriptors and resets the ring cursor before evaluation continues.

Buffered rendering retains the referenced host strings and joins the drained
ranges into one JavaScript string at completion. Streaming rendering converts
drained ranges into pull-driven chunks and pauses the evaluator until the
consumer requests more data.

Captured bodies, including block assignments and macro output, build lazy host
string compositions from range descriptors. Nested sinks retain their parent
descriptor sequence, never expose captured ranges to a streaming consumer, and
restore the parent sink before assigning the captured host handle. Capture
failure follows the same render-wide cleanup path as ordinary output failure.

A streaming consumer may observe earlier chunks before a later error. That is
part of the streaming contract and must be documented in the public API.

## Reset and reclamation

Completion, failure, and cancellation all run the same render cleanup:

1. invalidate the render epoch;
2. clear capability, continuation, and host string state;
3. reset the slot, source/input, member, command, query, and output cursors; and
4. verify that the fixed pool boundaries and singleton state are intact before
   returning the worker to the pool.

The backing capacity is reused exactly as configured. The worker neither grows
nor shrinks its Wasm memory in response to a render.
