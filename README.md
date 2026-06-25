# Nunjitsu

Nunjitsu is a secure native TypeScript template engine for direct string
rendering. It supports a focused subset of
[Nunjucks 3.2.4](https://mozilla.github.io/nunjucks/) through a closed,
synchronous interpreter rather than generated JavaScript.

Use Nunjitsu when templates may be untrusted and the application needs explicit
control over every value and function exposed to them. The package targets
Node.js 22 or newer and accepts inline template source only; filesystem loading,
precompilation, streaming, browser execution, and asynchronous callbacks are
outside its scope.

Use the
[Nunjucks templating documentation](https://mozilla.github.io/nunjucks/templating.html)
as the general syntax reference, then check the local
[compatibility guide](docs/compatibility.md) for the subset supported by
Nunjitsu. See the [security model](docs/security.md) for trust-boundary details.

## Installation

Install using your favorite package manager:

```sh
pnpm add nunjitsu
```

```sh
npm install nunjitsu
```

```sh
yarn add nunjitsu
```

## TypeScript API

### Quick start

Create a renderer once, then render templates synchronously:

```ts
import { createTemplateRenderer } from 'nunjitsu';

const renderer = createTemplateRenderer();

const output = renderer.render('Hello ${{ name }}!', {
  name: 'world',
});

console.log(output); // Hello world!
```

The default variable delimiters are `${{` and `}}`.

### Creating a renderer

```ts
function createTemplateRenderer(
  options?: TemplateRendererOptions,
): TemplateRenderer;
```

`createTemplateRenderer` returns an immutable renderer. Its filters, globals,
delimiter mode, and whitespace behavior cannot be changed after creation.

| Option               | Type                                       | Default | Description                                                     |
| -------------------- | ------------------------------------------ | ------- | --------------------------------------------------------------- |
| `filters`            | `Readonly<Record<string, TemplateFilter>>` | `{}`    | Trusted synchronous template filters.                           |
| `globals`            | `Readonly<Record<string, TemplateGlobal>>` | `{}`    | Trusted values and synchronous functions.                       |
| `cookiecutterCompat` | `boolean`                                  | `false` | Uses `{{` and `}}` plus supported Jinja compatibility behavior. |
| `trimBlocks`         | `boolean`                                  | `false` | Removes one newline immediately after block tags.               |
| `lstripBlocks`       | `boolean`                                  | `false` | Removes indentation before block tags on otherwise blank lines. |

### Rendering

```ts
interface TemplateRenderer {
  render(
    source: string,
    context?: TemplateContext | PreparedTemplateContext,
    options?: TemplateRenderOptions,
  ): string;
}
```

Each call parses and renders one complete template.

```ts
const result = renderer.render(
  '${{ user.name }} has ${{ items | length }} items',
  {
    user: { name: 'Patrik' },
    items: ['one', 'two'],
  },
);
```

`TemplateRenderOptions` configures per-render resource limits. See
[Security](docs/security.md#resource-limits) for details.

### Prepared contexts

Use a prepared context when the same data is rendered repeatedly. It is copied
once into an immutable snapshot owned by the renderer:

```ts
interface TemplateRenderer {
  prepareContext(context?: TemplateContext): PreparedTemplateContext;
}

interface PreparedTemplateContext {
  withPath(
    path: readonly string[],
    value: TemplateValue,
  ): PreparedTemplateContext;
}
```

`withPath` returns a new snapshot and leaves the original unchanged.

```ts
const initial = renderer.prepareContext({
  parameters: { service: 'catalog' },
  steps: {},
});

const afterBuild = initial.withPath(['steps', 'build'], {
  output: { image: 'example/catalog:1.0' },
});

renderer.render('${{ steps.build.output.image }}', afterBuild);
```

A prepared context can only be used with the renderer that created it.

### Template values

Contexts and capability results use plain data values:

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
```

Filters and global functions must be synchronous.

```ts
const renderer = createTemplateRenderer({
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

See [Security](docs/security.md#capabilities) for the capability boundary and
failure behavior.

## Development

Development requires Node.js 22.18 or newer and the pnpm version pinned in
`package.json`.

```sh
pnpm install
pnpm test
```

Run `pnpm benchmark` for the full Nunjucks comparison harness. Architecture,
testing, compatibility, and release documentation start in
[`docs/`](docs/index.md). Contributors and coding agents must also follow
[`AGENTS.md`](AGENTS.md).

## License

Licensed under the [MIT License](LICENSE). Adapted Nunjucks tests retain their
upstream license and attribution as documented in
[Compatibility](docs/compatibility.md#attribution-and-licensing).
