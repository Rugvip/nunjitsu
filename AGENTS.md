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
  may be used throughout the package outside the closed interpreter boundary.
- Keep the TypeScript/npm package at the repository root. Author one erasable
  `.ts` source tree and compile it into tested ESM and CommonJS builds with
  generated declarations using the lockfile-pinned TypeScript 7.0 RC.
- Construct engines synchronously. Rendering remains asynchronous because
  loaders and capabilities may be asynchronous. Engine-level loaders and
  capabilities are immutable after creation.
- Implement template execution as a closed native TypeScript interpreter in
  the caller process. Do not add Rust, Wasm, a worker protocol, or generated
  JavaScript execution back into the runtime.
- Parse each complete source into an immutable, data-only AST before executing
  it. AST nodes must not contain functions, host objects, property descriptors,
  or executable closures.
- Do not use `eval`, `Function`, constructor-derived equivalents, `node:vm`,
  generated JavaScript, dynamic import, or a JavaScript parser to execute
  template syntax.
- Copy context and capability results into the closed engine-owned value graph.
  Never retain live host objects, prototypes, getters, functions, methods, or
  iteration protocols in template-visible values.
- Store scopes and records in private maps and implement every lookup,
  coercion, comparison, and call explicitly by internal value kind. Never use
  reflective host property access as an evaluator shortcut.
- Reserve `constructor`, `prototype`, and `__proto__` across input, syntax,
  scopes, registries, lookup, assignment, and callback results.
- Make sealed interpreter variants for macros, built-ins, and registered
  capabilities the only callable values. Context functions and object methods
  are unsupported.
- Never retain template sources, dependency graphs, ASTs, values, or output
  state between renders by default.
- Treat template source as fully untrusted. Copy context into the safe value
  model; do not expose prototypes, getters, arbitrary functions, or live host
  objects. Host behavior requires explicit capability handles.
- Apply high finite cooperative resource limits by default on every render.
  Account for source size, AST nodes, evaluator steps, depth, collection growth,
  output, loaders, and capabilities. Do not describe these checks as process
  isolation or exact CPU/RSS accounting.
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
  parser, interpreter, and public API tests. Classify every upstream v3.2.4
  test in the parity manifest.

The rationale and detailed contracts live in:

- [`docs/architecture.md`](docs/architecture.md)
- [`docs/runtime-and-memory.md`](docs/runtime-and-memory.md)
- [`docs/security.md`](docs/security.md)
- [`docs/compatibility.md`](docs/compatibility.md)
- [`docs/typescript-api.md`](docs/typescript-api.md)
- [`docs/testing.md`](docs/testing.md)

## Repository structure

- `src/`: TypeScript public API, parser, interpreter, loaders, and capabilities.
- `src/parser/`: tokenizer and closed template/expression parser.
- `src/runtime/`: safe values, scopes, interpreter, output, and limits.
- `benchmarks/`: equivalent one-shot workloads and the isolated Nunjucks
  comparison harness.
- `tests/compat/`: shared Nunjucks v3.2.4 cases, provenance, manifest, and
  upstream license.
- `docs/`: normative architecture documentation.
- Generated JavaScript, declarations, coverage, and fuzz artifacts belong
  in ignored build directories, never beside authored source.

Do not create additional packages without a documented architectural reason.

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
  different style. Avoid `any` at safe-value and capability boundaries.

## Interpreter security rules

- Keep tokenizer, parser, AST types, values, scopes, evaluator, capabilities,
  output, and limits in responsibility-focused modules.
- Use exhaustive discriminated-union handling for AST nodes, values, and
  callable variants. An unknown variant is an internal error, never a fallback
  to JavaScript behavior.
- Validate the complete template before executing any node from that source.
- Inspect input records through own property descriptors and reject accessors.
  Do not invoke getters while copying accepted plain records.
- Keep parser and evaluator internals private. Do not pass AST nodes, scopes,
  internal values, or callable variants to host callbacks.
- Use explicit coercion helpers. Never call `String`, `Number`, `valueOf`,
  `toString`, iterators, or methods on unvalidated objects.
- Treat every production dependency imported by parser or runtime code as part
  of the trusted computing base and review it accordingly.
- Maintain automated static checks for prohibited dynamic execution and host
  reflection in parser and interpreter modules.
- Add attack regression tests before fixing any discovered interpreter escape.

## Testing rules

- Prefer fewer thorough tests with related assertions over many tiny tests.
- Put Nunjucks semantic behavior in the shared compatibility corpus rather than
  duplicating fixtures across parser, interpreter, and API tests.
- Never skip or mark an upstream case expected-failing without a parity-manifest
  entry containing provenance and a reason tied to the compatibility contract.
- Test source `.ts` directly on the minimum Node version. Also test both built
  package entry paths and asynchronous rendering.
- Every failure and cancellation path must prove that the engine retains no
  partial render state and the next render starts cleanly.
- Security-sensitive parsing, value copying, lookup, coercion, and call changes
  require malformed input tests, gadget regression tests, and fuzz coverage
  where appropriate.
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
