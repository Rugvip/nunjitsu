# Nunjitsu

Nunjitsu is a Node.js template engine aiming for template and runtime
compatibility with [Nunjucks 3.2.4](https://github.com/mozilla/nunjucks/tree/v3.2.4).
Its core is implemented in Rust, compiled to WebAssembly, and executed in Node
worker threads behind a new asynchronous TypeScript API.

The project prioritizes:

- compatibility with existing Nunjucks templates and observable rendering
  behavior;
- secure, resource-bounded execution of untrusted templates;
- low retained memory for templates rendered infrequently; and
- a data-driven shared-memory runtime without precompilation or persistent
  compiled-template caches.

Nunjitsu intentionally provides a new API rather than emulating the Nunjucks
JavaScript API. The initial runtime target is Node.js only.

## Status

Nunjitsu is in its architecture and initial implementation phase. The normative
design, compatibility boundaries, and testing strategy are documented in
[`docs/`](docs/index.md). Contributors should also read [`AGENTS.md`](AGENTS.md).

## Setup

Development requires Node.js 24.12 or newer, npm, and rustup. The repository
pins its Rust toolchain and TypeScript 7 native compiler.

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
