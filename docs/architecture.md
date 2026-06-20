# Architecture

## Purpose

Nunjitsu is a Node.js template engine implemented in Rust, compiled to WebAssembly,
and executed in Node worker threads. It targets the observable template and
runtime behavior of Nunjucks 3.2.4 while replacing Nunjucks's JavaScript API
with an asynchronous, typed API.

The design prioritizes:

- safe execution of untrusted templates;
- low retained memory for templates rendered infrequently;
- compact, data-driven execution in shared Wasm memory;
- one-shot compilation and rendering rather than precompilation or persistent
  compiled-template caches; and
- an attributed, auditable compatibility suite derived from upstream tests.

Throughput for repeatedly rendered templates is secondary to predictable
resource use and low retention.

## System boundaries

```mermaid
flowchart LR
    A["Node.js caller"] --> B["TypeScript Engine"]
    B --> C["Lazy worker pool"]
    C --> D1["Worker thread 1"]
    C --> D2["Worker thread N"]
    D1 <--> M1["Worker-owned shared Wasm memory"]
    D2 <--> M2["Worker-owned shared Wasm memory"]
    D1 --> W1["Rust/Wasm engine"]
    D2 --> W2["Rust/Wasm engine"]
    B <--> E["Trusted loaders and capabilities"]
    D1 -. "yield/resume" .-> E
    D2 -. "yield/resume" .-> E
```

### TypeScript engine

The engine is the public lifetime boundary. It owns:

- an immutable registry of loaders, filters, tests, globals, and declarative
  extension schemas;
- the compiled Wasm module and a lazy, bounded worker pool;
- queueing, cancellation, capability dispatch, output collection, and explicit
  disposal; and
- encoding safe input values into worker memory and decoding results.

Node-specific APIs may be used throughout this layer. Browser support is not a
current goal and must not constrain the Node implementation.

### Worker

Each worker owns one shared `WebAssembly.Memory` and one Wasm instance. The
memory is shared between the Node main thread and that worker, but is not shared
with other workers. A worker executes exactly one render at a time and remains
reserved while that render is suspended on a trusted host capability.

### Rust/Wasm engine

One Rust crate under `rust/` contains the parser, evaluator, arena, value model,
resource accounting, and raw Wasm ABI. Logical modules must keep domain logic
separate from ABI handling even though they live in one crate. The same crate
must remain testable natively where behavior does not depend on Wasm.

## Render lifecycle

A render is an isolated unit of ownership:

1. The TypeScript engine assigns an idle worker and creates a render-local
   capability namespace.
2. Context data and the entry template are encoded into that worker's shared
   memory. Named templates are obtained only through explicitly configured
   loaders.
3. Rust parses and evaluates ordinary nodes as a stream. It retains compact AST
   records only for bodies that must execute later or repeatedly, such as
   macros, blocks, loops, and inheritance overrides.
4. A loader or host capability request yields an explicit evaluator
   continuation. Loader requests carry the current source's canonical identity
   so relative dependencies resolve correctly through deferred frames. The
   worker remains reserved, and the main thread resumes it after encoding the
   response.
5. Buffered rendering resolves to one string. Streaming rendering exposes
   bounded chunks with backpressure.
6. Completion, failure, or cancellation invalidates every render-local offset
   and resets the arena wholesale. Template sources, AST records, context
   values, evaluation frames, and output are never cached across renders.

The worker, Wasm instance, and normal allocation capacity may be retained. A
worker whose memory exceeds a configurable retained-memory threshold is
recycled after the render so an outlier cannot pin its high-water allocation.

## Repository boundary

The TypeScript/npm package lives at the repository root. The single Rust crate
lives under `rust/`. The attributed, language-neutral compatibility corpus
lives under `tests/compat/` and is consumed by both implementation layers.

Planned ownership is:

```text
.
├── src/                 TypeScript public API, engine, and worker host
├── rust/                Single Rust engine and Wasm ABI crate
├── tests/
│   └── compat/          Shared Nunjucks v3.2.4 corpus and parity manifest
├── docs/                Normative architecture documentation
├── AGENTS.md            Project-wide contribution constraints
└── README.md            Introduction and minimal setup
```

Build artifacts, generated declarations, and copied upstream materials must be
clearly separated from authored source.

## Architectural non-goals

- A Nunjucks-compatible JavaScript API.
- Browser support.
- A precompiler or persistent compiled-template cache.
- Implicit filesystem access relative to the process working directory.
- Live proxying of arbitrary JavaScript object graphs into templates.
- Arbitrary JavaScript parser extensions for custom tags.
- Custom lexer delimiters or public lexer-token and parser-AST APIs.

See the area documents for the rationale and exact boundaries.
