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

## Setup

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
