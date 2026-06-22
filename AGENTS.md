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

- Target Node.js 22 or newer. Browser support is out of scope, and Node APIs
  may be used throughout the package outside the closed interpreter boundary.
- Keep the TypeScript package at the repository root and manage it with the
  `packageManager`-pinned pnpm version and `pnpm-lock.yaml`. Do not add another
  package-manager lockfile. Author one erasable `.ts` source tree and compile it
  into tested ESM and CommonJS builds with generated declarations using the
  lockfile-pinned TypeScript 7.0 RC.
- Construct engines synchronously and render synchronously. Engine-level
  filters and globals are immutable after creation.
- Implement template execution as a closed native TypeScript interpreter in
  the caller process. Do not add Rust, Wasm, a worker protocol, or generated
  JavaScript execution back into the runtime.
- Parse each complete source into an immutable, data-only AST before executing
  it. AST nodes must not contain functions, host objects, property descriptors,
  or executable closures.
- Represent AST variants as frozen plain object nodes with stable direct typed
  properties and direct child references. Do not add generic field bags,
  packed numeric arenas, or ArrayBuffer storage without a measured end-to-end
  benefit that justifies the additional evaluator complexity.
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
  scopes, registries, internal record construction, lookup, assignment, and
  capability arguments and results.
- Make sealed interpreter variants for macros, built-ins, and registered
  capabilities the only callable values. Context functions and object methods
  are unsupported.
- Never retain template sources, ASTs, values, or output state between renders
  by default. Retain values only through an explicit caller-owned prepared
  context snapshot; keep snapshots immutable and engine-bound, and copy every
  update through the safe value boundary.
- Treat template source as fully untrusted. Copy context into the safe value
  model; do not expose prototypes, getters, arbitrary functions, or live host
  objects. Host behavior requires explicit capability handles.
- Apply high finite cooperative resource limits by default on every render.
  Account for source size, AST nodes, evaluator work, depth, output,
  filter-argument scratch size, and capability calls. Do not describe these
  checks as general heap limits, process isolation, or exact CPU/RSS accounting.
- Accept inline template source only. Filesystem discovery and path policy
  belong to the application outside Nunjitsu. Reject include, import, from, and
  extends because the secure direct-string API does not support template loading.
- Target the documented secure direct-string subset of Nunjucks v3.2.4, not its
  complete JavaScript or template-loading API. Precompilation, browser
  execution, streaming, async callbacks, exact upstream error text, live-object
  semantics, custom tests, and parser extensions are outside the contract.
- Use `${{` and `}}` as the default variable delimiters. Cookiecutter mode uses
  `{{` and `}}` with the supported Jinja compatibility behavior. Do not expose
  arbitrary delimiter configuration or the Nunjucks lexer/parser object model.
- Maintain one attributed parity manifest and language-neutral compatibility
  corpus, with explicit supplemental coverage mappings for parser, interpreter,
  and public API behavior. Classify every upstream v3.2.4 test in the manifest.
- Publish only through `.github/workflows/publish.yml` using npm trusted
  publishing bound to the `npm` GitHub environment. Ongoing releases must be
  staged from an exact stable-version GitHub Release tag, never published with
  a repository npm token.

The rationale and detailed contracts live in:

- [`docs/architecture.md`](docs/architecture.md)
- [`docs/runtime-and-memory.md`](docs/runtime-and-memory.md)
- [`docs/security.md`](docs/security.md)
- [`docs/compatibility.md`](docs/compatibility.md)
- [`docs/testing.md`](docs/testing.md)
- [`docs/releasing.md`](docs/releasing.md)

## Repository structure

- `src/`: TypeScript public API, parser, interpreter, filters, and globals.
- `src/parser/`: tokenizer and closed template/expression parser.
- `src/runtime/`: safe values, scopes, interpreter, output, and limits.
- `benchmarks/`: synchronous inline parsing and expression comparisons with
  the pinned Nunjucks baseline.
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
  lifetime, units, failure behavior, and security implications where relevant.
- Build ESM and CommonJS from the same TypeScript entrypoint. Do not add
  format-specific source implementations, entry adapters, or runtime behavior.
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
- Revalidate template-controlled data whenever it changes semantic role, such
  as a value becoming a key, path segment, binding, or callable identity.
  Enforce the invariant in the owning representation as well as at external
  boundaries.
- Treat capability exceptions as fail-stop opaque values. Do not inspect the
  thrown value, resume template evaluation, or make any part of it visible to
  the template runtime.
- Complete public API validation before template evaluation. Pass through only
  `NunjitsuLimitError` from evaluation and wrap every other evaluation failure
  in `NunjitsuRenderError`, regardless of its underlying JavaScript error class.
- Never interpolate raw template source or decoded token values into
  diagnostics. Use the central bounded diagnostic formatter and keep the public
  render-error message independently neutralized and single-line.
- Ensure transient JavaScript containers passed to host operations such as
  serialization cannot observe inherited accessors, coercion hooks,
  serialization hooks, or methods.
- Use explicit coercion helpers. Never call `String`, `Number`, `valueOf`,
  `toString`, iterators, or methods on unvalidated objects.
- Treat every production dependency imported by parser or runtime code as part
  of the trusted computing base and review it accordingly.
- Keep the production parser and standard library dependency-free. Nunjucks is
  a development-only compatibility oracle and benchmark baseline and must not
  be imported by `src/`.
- Maintain automated static checks for prohibited dynamic execution and host
  reflection in parser and interpreter modules.
- Add attack regression tests before fixing any discovered interpreter escape.

## Testing rules

- Prefer fewer thorough tests with related assertions over many tiny tests.
- Put Nunjucks semantic behavior in the shared compatibility corpus rather than
  duplicating fixtures across parser, interpreter, and API tests.
- Never skip or mark an upstream case expected-failing without a parity-manifest
  entry containing provenance and a reason tied to the compatibility contract.
- Every manifest entry marked `ported` or `adapted` must link executable
  coverage through `cases.json` or `coverage.json`. `ported` means all
  applicable assertions in that upstream test are preserved; `adapted` needs a
  reason identifying the deliberate difference. Suite-level coverage ranges
  must be explicit and backed by a test that enumerates the selected behavior.
- When changing the pinned Nunjucks baseline or inventory, compare it against
  an exact upstream checkout with
  `scripts/compat/verifyNunjucksInventory.mjs`.
- Test source `.ts` directly on Node.js 22.18 or newer. When runtime or build
  compatibility changes, validate the built package against the Node.js 22
  package minimum. Also test both built package entry paths and synchronous
  rendering.
- Every failure path must prove that the engine retains no partial render state
  and the next render starts cleanly.
- Security-sensitive parsing, value copying, lookup, coercion, and call changes
  require malformed input tests, gadget regression tests, and fuzz coverage
  where appropriate.
- Keep parser/template and expression benchmark workloads output-equivalent
  across Nunjitsu and pinned Nunjucks. Do not add callback benchmarks or turn
  noisy performance measurements into test thresholds.

## Changesets

- Add a `.changeset/*.md` entry for every change that affects the published
  package. Infrastructure, documentation-only, test-only, and private tooling
  changes do not require one.
- Create and inspect changeset files through direct file operations rather than
  invoking Changesets CLI commands. Each entry must name `nunjitsu`, select the
  correct semantic bump, and describe the user-visible package change.
- Run `pnpm version:packages` only when intentionally preparing a release. It
  consumes pending entries, updates `package.json` and `CHANGELOG.md`, and the
  resulting version change must be committed before creating its matching tag.

## Documentation rules

- Keep `README.md` focused on the project introduction, high-level goals,
  current status, installation, complete public TypeScript API reference,
  minimal development setup, and links into `docs/`.
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
- Keep `index.ts` files as thin public entrypoints that generally only
  re-export declarations from responsibility-focused modules. Do not place
  substantial implementation in index files or add format-specific entrypoints.
- When a module exists primarily to provide one main export, name the file
  after that export, including its casing, such as `createEngine.ts` for
  `createEngine`.
- Add comments only for non-obvious invariants, architecture, or intentionally
  surprising behavior. Prefer self-explanatory names and types.
- Keep security and memory ownership visible in APIs. Reject invalid states at
  boundaries rather than compensating for them deeper in the engine.
- Avoid speculative abstractions and persistent caches. Add complexity only for
  a measured need that fits the documented optimization target.
