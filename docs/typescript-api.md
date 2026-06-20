# TypeScript API

## API shape

The public API is asynchronous and centered on an explicitly managed engine:

```ts
const engine = await createEngine({
  loaders: [fileSystemLoader({ roots: [templateRoot] })],
  filters: {
    async lookup(input, arguments_, { signal }) {
      return await applicationLookup(input, arguments_, { signal });
    },
  },
  workerPool: { minWorkers: 1, maxWorkers: 4 },
});

try {
  const html = await engine.render(
    { name: 'page.njk' },
    { title: 'Nunjitsu' },
    { signal, limits },
  );

  const stream = engine.renderStream(
    { source: inlineTemplate },
    context,
    { signal, limits },
  );
} finally {
  await engine.dispose();
}
```

The example fixes the architectural concepts, not final parameter names.
Public API design may refine names while preserving these contracts:

- `createEngine` initializes the compiled Wasm module and minimum worker pool.
- Engine-level loaders and capabilities are immutable after creation.
- `render` resolves to one string or rejects without returning a partial value.
- `renderStream` returns a Web `ReadableStream<string>` with pull-based
  backpressure and may error after emitting earlier chunks.
- Render options carry cancellation and per-render resource limits.
- Interpolated values are autoescaped by default; `autoescape: false` is an
  explicit engine-level compatibility override.
- Engine disposal is explicit and asynchronous; it rejects or cancels queued
  work and terminates workers deterministically.

The API does not emulate Nunjucks classes or callbacks.

## Template and context inputs

A render accepts inline source or a named template resolved by an explicit
loader. There is no implicit filesystem loader. Named dependencies discovered
through include, import, or inheritance use the same configured loader chain.
Every loaded source has a canonical identity. Dependency requests pass the
requesting source's canonical identity to `TemplateLoader.load` as the optional
third `from` argument, after the render-owned `AbortSignal`. Built-in loaders
use `from` only for names beginning with `./` or `../`; other names retain
loader-root lookup semantics.

Inline source is anonymous by default. A caller that wants relative includes,
imports, or inheritance supplies `canonicalName` with the source. This is a
stable identity, not an ambient working directory: for example, use a `file:`
URL under a configured filesystem root or the matching `memory:` identity for
an in-memory source. The identity also participates in cycle detection.

`include ... ignore missing` suppresses only the case where every loader returns
`null`; invalid names, root escapes, I/O failures, and other loader errors still
reject the render.

Context values are copied into the safe value model described in
[Security](security.md). Public types must make unsupported live objects and
explicit capability handles visible rather than accepting an unbounded `any`
graph.

## Capability configuration

Engine configuration assigns stable numeric identities to filters, tests,
globals, loaders, and declarative tag schemas. The caller cannot add or remove
them after `createEngine` resolves. This makes every worker's authority
consistent and every queued render auditable.

Render-local capabilities, if present in context, use a render-local namespace
and expire with that render. They do not alter global registrations.

Host callbacks may be asynchronous. They receive decoded safe values, not raw
arena offsets, and their results are validated and encoded before evaluation
resumes. Callbacks and loaders are trusted application code.

`filters`, `tests`, and callable `globals` are immutable name-to-function
records on `EngineOptions`. A filter receives its input separately from its
remaining arguments, a test must return a boolean, and a global receives its
argument array. Every callback also receives a render-owned `AbortSignal`.
Returned values cross the same safe-value encoder as context input and are not
implicitly safe; callbacks must return `markSafe(value)` to bypass escaping.

Custom tags use an explicit schema rather than a parser object. The
`{ type: 'inline', render }` schema accepts `{% name %}`, legacy whitespace
arguments, or a parenthesized argument list such as
`{% name("label", user.id) %}` and has no body. The
`{ type: 'body', endTag?, intermediateTags?, render }` schema declares a closing
tag (defaulting to `end${name}`) and an ordered set of optional intermediate
sections. Rust validates the complete directive, renders each body through
bounded evaluator frames, and resolves the numeric identity before the host
renderer runs. The body renderer receives immutable positional arguments, a
null-prototype keyword record, the first rendered body, and a null-prototype
record of intermediate sections that appeared. Neither schema exposes parser
hooks or internal syntax records.

Each configured name receives a stable numeric engine-lifetime identity. The
name tables are copied into each render arena so Rust resolves syntax before it
yields a numeric request. The main thread validates the request category and
identity, invokes exactly one registered callback, copies the result into the
arena, and resumes the recorded expression continuation. Capability calls are
charged against the per-render `capabilityCalls` limit.

## Source and build constraints

The package is authored in `.ts` at the repository root and targets Node.js
24.12 or newer. Development tests execute source directly through Node's stable
built-in type stripping. Source must therefore use erasable TypeScript syntax.

Project configuration must enforce the equivalent of:

```json
{
  "compilerOptions": {
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "rewriteRelativeImportExtensions": true,
    "strict": true
  }
}
```

Do not use runtime enums, parameter properties, runtime namespaces, import
aliases, or other syntax that requires transformation merely to execute tests.
Use explicit `type` imports and file extensions compatible with direct Node
execution.

The build uses the TypeScript 7.0 release candidate from `typescript@rc`. The
dependency must be lockfile-pinned. One source tree is compiled into separate
ESM and CommonJS output directories with generated `.d.ts` declarations.
Conditional package exports select the correct build. Package contract tests
must load both the `import` and `require` paths, including worker and Wasm asset
resolution.

These constraints follow Node's
[built-in TypeScript support](https://nodejs.org/api/typescript.html) and the
[TypeScript 7.0 RC](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0-rc/).

## Type documentation

Every declared TypeScript type and every exported API must have TSDoc that
explains ownership, lifetime, failure behavior, security implications, and
units for limits where relevant. Documentation must add information that the
type signature cannot express; it must not merely restate property names.
