# Nunjitsu

Nunjitsu is a secure native TypeScript implementation of a simpler Nunjucks
subset, optimized for secure direct string templating. It replaces generated
JavaScript execution with a closed interpreter and a small synchronous API.

The project prioritizes:

- compatibility with the Nunjucks syntax used by direct string templates;
- secure interpretation of untrusted templates with cooperative resource
  limits;
- a closed value model that gives templates no implicit access to JavaScript
  objects or ambient Node.js authority;
- low retained memory for templates rendered infrequently; and
- one-shot parsing and rendering without precompilation or persistent
  compiled-template caches.

Nunjitsu intentionally does not emulate the Nunjucks JavaScript API. The
runtime target is Node.js only.

## Status

The compatibility baseline is a secure direct-string subset of Nunjucks 3.2.4:
inline rendering, `${{ ... }}` variables, Cookiecutter compatibility,
synchronous filters, and JSON-valued or synchronous function globals. The
normative design and testing strategy are documented in [`docs/`](docs/index.md).
Contributors should also read [`AGENTS.md`](AGENTS.md).

## Installation

Nunjitsu requires Node.js 22 or newer.

```sh
pnpm add nunjitsu
```

The package provides equivalent ESM and CommonJS entrypoints:

```ts
import { createEngine } from 'nunjitsu';
```

```js
const { createEngine } = require('nunjitsu');
```

## TypeScript API

### Quick start

Create an engine once and render complete inline template strings
synchronously:

```ts
import { createEngine } from 'nunjitsu';

const engine = createEngine();
const output = engine.render('Hello ${{ name }}!', {
  name: 'world',
});

console.log(output); // Hello world!
```

The default variable delimiters are `${{` and `}}`. Template loading,
precompilation, streaming, asynchronous rendering, and context functions are
not part of the API.

### `createEngine`

```ts
function createEngine(options?: EngineOptions): Engine;
```

Creates an immutable engine synchronously. Filters, globals, whitespace
behavior, and rendering mode cannot be changed after creation.

`EngineOptions` accepts:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `filters` | `Readonly<Record<string, TemplateFilter>>` | `{}` | Trusted synchronous filters available through `value \| name(...)`. |
| `globals` | `Readonly<Record<string, TemplateGlobal>>` | `{}` | Trusted values and synchronous functions available by one valid template identifier. |
| `cookiecutterCompat` | `boolean` | `false` | Uses `{{` and `}}`, supported Jinja behavior, and the `jsonify` alias. |
| `trimBlocks` | `boolean` | `false` | Removes one LF or CRLF immediately after each block tag. |
| `lstripBlocks` | `boolean` | `false` | Removes indentation before block tags on otherwise blank lines. |

### `engine.render`

```ts
interface Engine {
  render(
    source: string,
    context?: TemplateContext | PreparedContext,
    options?: RenderOptions,
  ): string;
}
```

Parses and renders one complete inline source. The call returns the complete
string or throws; partial output is never returned. A plain context is copied
and validated on every call. Passing no context uses an empty record.

```ts
const result = engine.render(
  '${{ user.name }} has ${{ items | length }} items',
  {
    user: { name: 'Patrik' },
    items: ['one', 'two'],
  },
  {
    limits: { outputCodeUnits: 10_000 },
  },
);
```

The source must be a string. Nunjitsu accepts no filename or loader; callers
must read files and enforce path policy outside the engine. Interpolation is
never automatically escaped; rendered output remains attacker-controlled and
must be handled according to its destination.

### Prepared contexts

```ts
interface Engine {
  prepareContext(context?: TemplateContext): PreparedContext;
}

interface PreparedContext {
  withPath(path: readonly string[], value: TemplateValue): PreparedContext;
}
```

`prepareContext` copies and validates context data once for reuse across
renders. The returned snapshot is immutable, opaque, and bound to the engine
that created it.

`withPath` returns a new snapshot with one copied replacement. It structurally
shares unchanged engine-owned values, creates missing record segments, and
rejects traversal through an existing non-record value. The original snapshot
is unchanged.

```ts
const initial = engine.prepareContext({
  parameters: { service: 'catalog' },
  steps: {},
});

const afterBuild = initial.withPath(
  ['steps', 'build'],
  { output: { image: 'example/catalog:1.0' } },
);

engine.render('${{ steps.build.output.image }}', afterBuild);
```

A prepared context cannot be used with another engine. It retains its copied
values until the snapshot becomes unreachable; releasing it is not a guarantee
of secret-data zeroization.

### Template values and contexts

```ts
type TemplateValue =
  | null
  | boolean
  | number
  | string
  | readonly TemplateValue[]
  | Readonly<{ [key: string]: TemplateValue }>;

type TemplateContext = Readonly<Record<string, TemplateValue>>;
```

At runtime, records must be plain objects with either `Object.prototype` or a
null prototype. Nunjitsu copies enumerable own data properties without invoking
getters. It rejects accessors, symbols, custom prototypes, class instances,
functions, promises, cycles, and other behavior-bearing values.

The names `constructor`, `prototype`, and `__proto__` are reserved throughout
the template boundary. Later mutation of the caller's input objects is never
observed by an active render or prepared context.

### Filters and globals

```ts
type TemplateFilter = (
  input: TemplateValue | undefined,
  ...arguments_: readonly (TemplateValue | undefined)[]
) => TemplateValue | undefined;

type TemplateGlobalFunction = (
  ...arguments_: readonly (TemplateValue | undefined)[]
) => TemplateValue | undefined;

type TemplateGlobal = TemplateValue | TemplateGlobalFunction;

interface TemplateCapabilities {
  filters?: Readonly<Record<string, TemplateFilter>>;
  globals?: Readonly<Record<string, TemplateGlobal>>;
}
```

Capabilities are trusted host code and are the only way templates invoke
JavaScript behavior. They must execute synchronously. Filters receive their
input followed by positional arguments; global functions receive positional
arguments. Returning `undefined` creates an absent template value.

Global names must be single template identifiers; dotted registry names are
rejected. A call first resolves its target through lexical scope and the closed
runtime value model. Context and local bindings therefore shadow configured
globals normally. Capability aliases retain a sealed identity for the exact
registered callback rather than deriving authority from call-site spelling.

```ts
const configured = createEngine({
  filters: {
    slugify(input) {
      if (typeof input !== 'string') {
        throw new TypeError('slugify requires a string');
      }
      return input.toLowerCase().replaceAll(' ', '-');
    },
  },
  globals: {
    environment: 'production',
    deployment(name) {
      if (typeof name !== 'string') {
        throw new TypeError('deployment requires a string');
      }
      return { name, ready: true };
    },
  },
});
```

Arguments are frozen copies of internal values. Results pass through the same
validator as context input. Templates cannot access callback functions, live
host objects, object methods, or capability exceptions. If a capability
throws, rendering stops immediately and no later template expression or
capability executes.

Capability failures preserve a bounded, control-free detail only when the
thrown value is a primitive string or a native error with an own string data
property named `message`. Every other value produces a fixed diagnostic. The
original thrown value is discarded and never retained in the public error's
cause chain. Preserved details may still contain sensitive application data;
do not return them automatically to untrusted clients.

Capability authors must still treat all arguments as attacker-controlled data.
The value boundary prevents access to JavaScript authority; it does not make
the data trustworthy for application-specific operations.

### Resource limits

```ts
interface RenderOptions {
  limits?: Partial<RenderLimits>;
}

interface RenderLimits {
  sourceCodeUnits: number;
  astNodes: number;
  workUnits: number;
  nestingDepth: number;
  outputCodeUnits: number;
  scratchBytes: number;
  capabilityCalls: number;
}
```

Every render uses high finite cooperative defaults:

| Limit | Default | Meaning |
| --- | ---: | --- |
| `sourceCodeUnits` | `4_194_304` | Total UTF-16 source code units parsed. |
| `astNodes` | `1_000_000` | Immutable AST nodes created. |
| `workUnits` | `1_000_000` | Evaluator work units consumed. |
| `nestingDepth` | `512` | Nested interpreter evaluation depth. |
| `outputCodeUnits` | `16_777_216` | UTF-16 code units in the returned string. |
| `scratchBytes` | `67_108_864` | Estimated UTF-8 bytes supplied to one filter. |
| `capabilityCalls` | `4_096` | Filter and global-function invocations. |

Overrides must be non-negative safe integers or `Infinity`. Limits are
cooperative guards, not exact CPU, heap, RSS, or process-isolation controls.

### Errors

The package exports two error classes:

- `NunjitsuRenderError` reports parser or interpreter failures. Its `cause`
  retains the host-visible diagnostic chain, but thrown capability values are
  never exposed to template code.
- `NunjitsuLimitError` reports a resource-limit failure. Its `limit` property
  identifies the exceeded `RenderLimits` field when available.

Invalid source, context, prepared-context ownership, capability configuration,
and reserved names supplied through those API inputs throw `TypeError` before
template evaluation. Invalid limit values similarly throw `RangeError`.
After API validation, every parser or evaluator failure other than resource
limit exhaustion is wrapped in `NunjitsuRenderError`, regardless of its
underlying JavaScript error class. Public diagnostic messages escape terminal
and line-control characters, remain single-line, and have bounded length. All
render failures discard partial output and leave the engine ready for a clean
subsequent render.

### Exported API

The package root exports:

| Export | Kind | Purpose |
| --- | --- | --- |
| `createEngine` | function | Creates an immutable synchronous engine. |
| `Engine` | type | Rendering and prepared-context methods. |
| `EngineOptions` | type | Immutable mode, whitespace, and capability configuration. |
| `RenderOptions` | type | Per-render cooperative limits. |
| `PreparedContext` | type | Opaque reusable context snapshot. |
| `TemplateValue` | type | Accepted recursively copied data values. |
| `TemplateContext` | type | Root template scope. |
| `TemplateCapabilities` | type | Filter and global registries. |
| `TemplateFilter` | type | Trusted synchronous filter signature. |
| `TemplateGlobal` | type | Global data or function union. |
| `TemplateGlobalFunction` | type | Trusted synchronous global signature. |
| `RenderLimits` | type | All configurable resource dimensions. |
| `NunjitsuRenderError` | class | Structured parser or evaluator failure. |
| `NunjitsuLimitError` | class | Resource-limit failure with an optional `limit` field. |

For the supported template-language subset, security model, and detailed
design constraints, see the [project documentation](docs/index.md).

## Development

Development requires Node.js 22.18 or newer and pnpm 11.3. The repository uses
its pinned TypeScript 7 native compiler for authoring and TypeScript 5.7 for
package consumer compatibility tests.

Install dependencies and run the complete source and package test matrix:

```sh
pnpm install
pnpm test
```

## License

Licensed under the [MIT License](LICENSE).

Copied or adapted Nunjucks test materials retain their upstream BSD-2-Clause
license and attribution as described in
[`docs/compatibility.md`](docs/compatibility.md#attribution-and-licensing).
