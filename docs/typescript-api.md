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
```

The public contracts are:

- `createEngine(options): Engine` validates immutable configuration;
- `engine.render(source, context?, options?): string` parses and renders one
  complete inline source;
- filters and globals are synchronous and immutable for the engine lifetime;
- render options carry cooperative resource limits; and
- interpolation is never automatically escaped, matching Backstage.

There are no loaders, streams, cancellation handles, worker pools, Wasm memory,
or disposal methods.

## Template and context inputs

The source is always an inline string. Backstage reads each scaffolder file and
enforces workspace paths before calling the renderer, so Nunjitsu has no
filesystem or template-loading API.

Context values are JSON-compatible primitives, arrays, and plain records.
Runtime validation copies accepted values before evaluation. Unsupported
objects, behavior, cycles, accessors, and reserved keys are rejected.

## Capability configuration

`filters` and globals are the only host behavior templates can invoke. Filters
receive their input followed by positional arguments. Globals may be JSON
values or synchronous functions receiving positional arguments. `undefined`
from a callback follows Backstage behavior and renders as an absent value.

Callbacks receive copied values and their results cross the same value
validator as context input. Context functions and object methods are
unsupported.

## Rendering modes

The default mode uses `${{` and `}}` for variables. `cookiecutterCompat: true`
uses `{{` and `}}`, enables the supported Jinja-compatible behavior, and adds
`jsonify` as an alias for `dump`. `trimBlocks` and `lstripBlocks` remain engine
options.

## Source and build constraints

The package is authored in erasable `.ts`, targets Node.js 24.12 or newer, and
builds tested ESM and CommonJS outputs with declarations. Parser and interpreter
sources must reject dynamic execution, generated code, Node `vm`, dynamic
imports, and host-object reflection.
