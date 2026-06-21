# Project instructions

These instructions apply to the entire repository. They exist to keep
implementation and documentation aligned with the architecture in
[`docs/`](docs/index.md).

## Before changing code

1. Read [`README.md`](README.md), [`docs/index.md`](docs/index.md), and the
   documentation page for the area being changed.
2. Check whether the change conflicts with a settled constraint below. Do not
   work around an architectural decision silently.
3. If a cross-cutting decision must change, update the relevant documentation
   and this file in the same change, including the reason and consequences.

## Project-wide architectural constraints

- Target Node.js 24.12 or newer. Browser support is out of scope, and Node APIs
  may be used throughout the host/worker boundary.
- Implement the engine in the single Rust crate under `rust/`, compile it to
  Wasm, and execute it only inside Node worker threads.
- Keep the TypeScript/npm package at the repository root. Author one erasable
  `.ts` source tree and compile it into tested ESM and CommonJS builds with
  generated declarations using the lockfile-pinned TypeScript 7.0 RC.
- Use an asynchronous engine API with explicit disposal. Engine-level loaders
  and capabilities are immutable after creation.
- Use a lazy, bounded worker pool. Each worker owns a separate shared Wasm
  memory, runs exactly one render at a time, and remains reserved across async
  capability yields.
- Cross the TypeScript/Rust boundary through the versioned raw Wasm ABI. Pass
  primitive numbers and validated offset/length records, not JavaScript object
  bindings.
- Store render data in one heterogeneous byte arena per worker. Use bounded
  integer offsets, explicit record tags and lengths, and render epochs. Never
  persist or expose an arena offset after cleanup.
- Parse and evaluate ordinary nodes as a stream. Retain compact AST records
  only for bodies whose semantics require deferred or repeated evaluation.
- Never retain template sources, dependency graphs, AST, values, or output
  between renders. Reset render state wholesale. Recycle workers that exceed
  the retained-memory threshold instead of pinning outlier allocations.
- Treat template source as fully untrusted. Copy context into the safe value
  model; do not expose prototypes, getters, arbitrary functions, or live host
  objects. Host behavior requires explicit capability handles.
- Apply finite resource limits by default on every render. Callers may
  explicitly loosen or disable them, which opts out of denial-of-service
  protection.
- Provide no ambient cwd filesystem access. Loading is inline or through
  explicit loaders; filesystem loaders are rooted and must prevent root escape.
- Resolve `./` and `../` dependencies from the requesting source's canonical
  identity. Preserve that identity through every deferred frame, and key
  render-local request caches by both canonical parent and requested name.
- Target Nunjucks v3.2.4 template/runtime behavior, not its JavaScript API.
  Precompilation, browser execution, exact upstream error text, live-object
  semantics, and arbitrary parser extensions are outside the compatibility
  contract.
- Keep the standard Nunjucks template delimiters fixed. Do not expose the
  replaced Nunjucks lexer token stream, parser AST object model, or mutable
  delimiter configuration through the TypeScript API.
- Adapt upstream tests into one attributed, language-neutral corpus consumed by
  Rust and TypeScript. Classify every upstream v3.2.4 test in the parity
  manifest.

The rationale and detailed contracts live in:

- [`docs/architecture.md`](docs/architecture.md)
- [`docs/runtime-and-memory.md`](docs/runtime-and-memory.md)
- [`docs/security.md`](docs/security.md)
- [`docs/compatibility.md`](docs/compatibility.md)
- [`docs/typescript-api.md`](docs/typescript-api.md)
- [`docs/testing.md`](docs/testing.md)

## Repository structure

- `src/`: TypeScript public API, engine, worker host, and built-in capabilities.
- `rust/`: the single Rust engine and Wasm ABI crate. Parsing is grouped under
  `expression/` and `template/`; `wasm/` is divided into runtime, evaluation,
  filter, and model responsibilities.
- `benchmarks/`: equivalent one-shot workloads and the isolated Nunjucks
  comparison harness.
- `tests/compat/`: shared Nunjucks v3.2.4 cases, provenance, manifest, and
  upstream license.
- `docs/`: normative architecture documentation.
- Generated JavaScript, declarations, Wasm, coverage, and fuzz artifacts belong
  in ignored build directories, never beside authored source.

Do not create additional packages or Rust crates without a documented
architectural reason.

## TypeScript rules

- Keep source compatible with Node's built-in type stripping. Enable and obey
  `erasableSyntaxOnly`, `verbatimModuleSyntax`, strict checking, and relative
  import extension rewriting.
- Do not use runtime enums, parameter properties, runtime namespaces, import
  aliases, decorators requiring transformation, or path aliases that Node
  cannot execute directly.
- Use explicit `type` imports and source file extensions that work when Node
  executes `.ts` directly.
- Add TSDoc to every declared type and every exported API. Document ownership,
  lifetime, units, cancellation, failure, partial-stream behavior, and security
  implications where relevant.
- Keep ESM and CommonJS behavior in one implementation. Format-specific code is
  limited to entry and asset-resolution adapters.
- Use braced control flow unless the surrounding file has an established
  different style. Avoid `any` at the safe-value and ABI boundaries.

## Rust and Wasm rules

- Keep parser, evaluator, arena, values, limits, and ABI in separate logical
  modules within the one crate. Domain logic must remain natively testable where
  practical.
- Treat `expression/mod.rs`, `template/mod.rs`, and `wasm/mod.rs` as assembly
  points. Keep implementations in responsibility-focused included files rather
  than widening internal visibility solely to create more Rust modules.
- Keep the Wasm export surface small, numeric, versioned, and validated.
- Treat all host-provided offsets, lengths, tags, continuation IDs, and state
  transitions as untrusted input.
- Prefer arena offsets and explicit indices over pointer-linked object graphs.
  Do not expose Rust layout as an accidental ABI.
- Avoid `unsafe`. When it is necessary for measured arena or ABI behavior,
  document the invariant at the unsafe boundary and add focused tests that
  exercise invalid inputs.
- Account for work and memory before performing it. Use checked arithmetic for
  sizes, offsets, counters, and limits.
- Run formatting, linting, native tests, Wasm boundary tests, and relevant fuzz
  regressions before considering Rust changes complete.

## Testing rules

- Prefer fewer thorough tests with related assertions over many tiny tests.
- Put Nunjucks semantic behavior in the shared compatibility corpus rather than
  duplicating fixtures in Rust and TypeScript.
- Never skip or mark an upstream case expected-failing without a parity-manifest
  entry containing provenance and a reason tied to the compatibility contract.
- Test source `.ts` directly on the minimum Node version. Also test both built
  package entry paths, worker startup, Wasm loading, and explicit disposal.
- Every failure and cancellation path must prove that the next render on the
  same worker starts from clean state.
- Security-sensitive parsing, record decoding, and ABI changes require malformed
  input tests and, where appropriate, fuzz coverage.
- Keep performance workloads output-equivalent across Nunjitsu and the pinned
  Nunjucks baseline. Disable Nunjucks template caching, isolate implementations
  in separate processes, and never turn noisy benchmark measurements into test
  thresholds.

## Documentation rules

- Keep `README.md` limited to the project introduction, high-level goals,
  current status, minimal setup, and links into `docs/`.
- Put design details in the page that owns the area. Add a new focused page only
  when no existing page has clear ownership, and link it from `docs/index.md`.
- Documentation describes the current intended design, not a chronological log.
  Replace superseded guidance and explain the reason in the change description.
- Update documentation in the same change as behavior. Do not defer it to a
  follow-up.
- Do not create standalone findings, investigation, or implementation-summary
  documents unless explicitly requested.
- Preserve upstream attribution and licensing adjacent to copied test material.

## General code quality

- Follow the existing style of each file and language. Do not mix styles within
  a file.
- Add comments only for non-obvious invariants, architecture, or intentionally
  surprising behavior. Prefer self-explanatory names and types.
- Keep security and memory ownership visible in APIs. Reject invalid states at
  boundaries rather than compensating for them deeper in the engine.
- Avoid speculative abstractions and persistent caches. Add complexity only for
  a measured need that fits the documented optimization target.
