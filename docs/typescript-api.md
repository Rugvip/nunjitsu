# TypeScript API

## API shape

Engine creation is synchronous. Rendering remains asynchronous:

```ts
const engine = createEngine({
  filters: {
    async lookup(input, arguments_, { signal }) {
      return await applicationLookup(input, arguments_, { signal });
    },
  },
});

const html = await engine.render(
  { source: templateSource },
  { title: 'Nunjitsu' },
  { signal, limits },
);

const stream = engine.renderStream(
  { source: inlineTemplate },
  context,
  { signal, limits },
);
```

The public contracts are:

- `createEngine(options): Engine` validates immutable configuration without
  asynchronous setup;
- loaders and capabilities are immutable for the engine lifetime;
- `render` resolves to one string or rejects without returning a partial value;
- `renderStream` returns a pull-driven `ReadableStream<string>` and may error
  after emitting earlier chunks;
- render options carry cancellation and cooperative resource limits; and
- interpolated values are autoescaped by default.

There are no worker-pool, Wasm-memory, ABI, or mandatory disposal options.

## Template and context inputs

A render accepts inline source or a named template resolved by an explicit
source loader. Nunjitsu has no filesystem loader; callers read files and apply
path policy outside the engine. Every loaded source has a canonical identity
used for relative dependency resolution, cycle detection, and render-local
deduplication.

This matches the Backstage scaffolder integration model: the fetch action
enumerates and reads each file, enforces workspace paths independently, and
passes each text file to the template engine as an inline string. Template
loading directives are not used for filesystem access in that flow.

Context values use a closed recursive public type consisting of primitives,
safe strings, readonly arrays, and readonly plain records. Runtime validation is
authoritative and copies all accepted values before parsing or evaluation.
Unsupported objects, behavior, and reserved keys are rejected.

## Capability configuration

`filters`, `tests`, callable `globals`, loaders, and declarative custom tags are
immutable name-to-function records on `EngineOptions`. They are trusted
application code and are the only host behavior templates can invoke.

Callbacks receive copied values and a render-owned `AbortSignal`. Returned
values cross the same safe-value validator as initial context and are not
implicitly safe. Context functions and object methods are unsupported.

Custom tags use declarative schemas rather than parser callbacks. Schemas may
declare arguments, a closing tag, and intermediate body sections. The closed
parser validates those forms and the interpreter invokes the registered
renderer by identity; no parser or AST object is exposed.

## Source and build constraints

The package is authored in erasable `.ts`, targets Node.js 24.12 or newer, and
builds tested ESM and CommonJS outputs with declarations. Production libraries
may be added normally but enter the trusted computing base and must remain
lockfile-pinned and reviewed.

Parser and interpreter sources must remain statically auditable. Project checks
must reject dynamic execution, generated code, Node `vm`, dynamic imports, and
host-object reflection within those modules.

## Type documentation

Every declared TypeScript type and exported API has TSDoc covering ownership,
lifetime, failure behavior, cancellation, units, and security implications
where relevant.
