# Nunjitsu

Nunjitsu is a secure native TypeScript implementation of a simpler Nunjucks
subset, optimized for secure direct string templating. It replaces generated
JavaScript execution with a closed interpreter and a small synchronous API.

The project prioritizes:

- compatibility with the Nunjucks syntax used by direct string templates;
- secure, resource-bounded execution of untrusted templates;
- low retained memory for templates rendered infrequently; and
- a closed value model that gives templates no access to JavaScript objects or
  ambient Node.js authority; and
- one-shot parsing and rendering without precompilation or persistent
  compiled-template caches.

Nunjitsu intentionally does not emulate the Nunjucks JavaScript API. The
runtime target is Node.js only.

## Status

The compatibility baseline is a secure direct-string subset of Nunjucks 3.2.4:
inline rendering, `${{ ... }}` variables, Cookiecutter compatibility,
synchronous filters, and JSON-valued globals. The
normative design and testing strategy are documented in [`docs/`](docs/index.md).
Contributors should also read [`AGENTS.md`](AGENTS.md).

## Setup

Development requires Node.js 24.12 or newer and npm. The repository pins its
TypeScript 7 native compiler.

Install dependencies and run the complete source and package test matrix:

```sh
npm install
npm test
```

## License

Licensed under the [Apache License 2.0](LICENSE).

Copied or adapted Nunjucks test materials retain their upstream BSD-2-Clause
license and attribution as described in
[`docs/compatibility.md`](docs/compatibility.md#attribution-and-licensing).
