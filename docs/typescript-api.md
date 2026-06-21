# TypeScript API

## API shape

Engine creation and rendering are synchronous:

```ts
const engine = createEngine({
  filters: {
    lookup(input, ...arguments_) {
      return applicationLookup(input, arguments_);
    },
  },
  globals: {
    deploymentEnvironment: 'production',
  },
});

const output = engine.render(templateSource, {
  values: { title: 'Nunjitsu' },
});

const prepared = engine.prepareContext({
  parameters,
  steps: {},
});
const next = prepared.withPath(
  ['steps', stepId],
  { output: stepOutput },
);
const laterOutput = engine.render(laterTemplateSource, next);
```

The public contracts are:

- `createEngine(options): Engine` validates immutable configuration;
- `engine.prepareContext(context?): PreparedContext` copies context data once
  into an opaque engine-owned snapshot;
- `preparedContext.withPath(path, value): PreparedContext` returns a new
  structurally shared snapshot with one copied update;
- `engine.render(source, context?, options?): string` parses and renders one
  complete inline source using either a plain or prepared context;
- filters and globals are synchronous and immutable for the engine lifetime;
- render options carry cooperative resource limits; and
- interpolation is never automatically escaped.

There are no loaders, streams, cancellation handles, worker pools, Wasm memory,
or disposal methods.

## Template and context inputs

The source is always an inline string. Applications perform any file reads and
enforce their own path policy before calling the renderer, so Nunjitsu has no
filesystem or template-loading API.

Context values are JSON-compatible primitives, arrays, and plain records.
Runtime validation copies accepted values before evaluation. Unsupported
objects, behavior, cycles, accessors, and reserved keys are rejected.

A plain context is copied on every render and remains the convenient one-shot
API. A prepared context retains only its closed copied value graph and can be
reused without inspecting the host input again. Prepared contexts are bound to
the engine that created them; passing one to another engine is rejected.

`withPath` is the explicit update mechanism for workflow data such as
`steps.<id>.output`. It copies and validates the replacement value, copies only
the records along the updated path, and shares all unchanged closed values.
Missing record segments are created, while traversing an existing non-record
value fails. The original snapshot remains unchanged. Temporary `each`, secret,
and redacted variants should be derived snapshots rather than mutations.

Prepared snapshots become eligible for garbage collection when the caller
releases them. Applications should keep secret-bearing snapshots scoped to one
task. JavaScript does not provide reliable memory zeroization, so dropping a
snapshot is not a secret-erasure guarantee.

## Capability configuration

`filters` and globals are the only host behavior templates can invoke. Filters
receive their input followed by positional arguments. Globals may be JSON
values or synchronous functions receiving positional arguments. `undefined`
from a callback renders as an absent value.

Callbacks receive copied values and their results cross the same value
validator as context input. Context functions and object methods are
unsupported.

If a callback throws, rendering stops immediately. Nunjitsu does not inspect
the thrown value or expose it to template code, and it never resumes evaluation
at a later template expression. The host receives a `NunjitsuRenderError` with
an engine-owned fixed message and an opaque cause chain for diagnostics.

## Rendering modes

The default mode uses `${{` and `}}` for variables. `cookiecutterCompat: true`
uses `{{` and `}}`, enables the supported Jinja-compatible behavior, and adds
`jsonify` as an alias for `dump`. `trimBlocks` and `lstripBlocks` remain engine
options.

## Source and build constraints

The package is authored in erasable `.ts`, targets Node.js 24.12 or newer, and
has one format-neutral source entrypoint. The build bundles that same entrypoint
into tested ESM and CommonJS outputs and emits one shared declaration tree.
Source code must not branch on or provide adapters for the package module
format. Parser and interpreter sources must reject dynamic execution, generated
code, Node `vm`, dynamic imports, and host-object reflection.
