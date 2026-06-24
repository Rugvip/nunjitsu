# Project instructions

These instructions apply to the entire repository.

## Before changing code

1. Read [`README.md`](README.md), [`docs/index.md`](docs/index.md), and the
   detailed implementation constraints in [`CONTEXT.md`](CONTEXT.md).
2. Do not work around a settled constraint silently. Update `CONTEXT.md` when
   an implementation invariant changes, and update the relevant human guide
   when the public behavior or tradeoff changes.
3. Preserve unrelated work in a dirty worktree and keep commits focused.

## Implementation

- Target Node.js 22 or newer and use the `packageManager`-pinned pnpm version.
- Keep source compatible with Node's built-in TypeScript type stripping and the
  strict options in `tsconfig.json`.
- Keep `index.ts` files as thin re-export surfaces. Put implementations in
  responsibility-focused modules, naming a single-export module after that
  export.
- Follow the existing style in each file. Use braced control flow and avoid
  `any` at safe-value or capability seams.
- Add TSDoc to exported API and declared types. Add implementation comments only
  for non-obvious invariants or deliberately surprising behavior.
- Treat parser and runtime changes as security-sensitive. Follow every invariant
  in [`CONTEXT.md`](CONTEXT.md), especially complete-source validation, closed
  value handling, callable authority, coercion, diagnostics, and resource
  accounting.
- Do not add production parser or standard-library dependencies without
  reviewing them as part of the trusted computing base.

## Testing

- Prefer fewer thorough tests with related assertions over many small tests.
- Put Nunjucks semantic behavior in the shared compatibility corpus. Every
  `ported` or `adapted` manifest entry must link executable coverage.
- Add an attack regression before fixing an interpreter escape or boundary
  violation. Failure tests must prove fail-stop behavior and a clean next render.
- Run source tests directly on Node.js 22.18 or newer. For runtime or packaging
  changes, also validate ESM, CommonJS, declarations, and the Node.js 22 package
  minimum through the complete test command.
- Keep benchmark workloads output-equivalent with pinned Nunjucks. Do not turn
  noisy timings into pass/fail thresholds.

## Changesets and releases

- Add a `.changeset/*.md` entry only when a published package changes. Edit
  changeset files directly; do not invoke the Changesets CLI for agents.
- Run `pnpm version:packages` only when intentionally preparing a release. The
  resulting `package.json` and `CHANGELOG.md` changes must be committed before
  pushing to `main`.
- Publish only through `.github/workflows/publish.yml` and npm trusted
  publishing. Never add an npm token to the repository or workflow.

## Documentation

- Keep `README.md` focused on the package introduction, installation, primary
  TypeScript API, minimal contributor workflow, and links to further guides.
- Keep `docs/` concise and optimized for human readers. Do not turn human guides
  into exhaustive implementation ledgers or regression inventories.
- Keep exact internal constraints in `CONTEXT.md`; update it alongside code when
  an invariant changes.
- Do not create standalone investigation, finding, or implementation-summary
  documents unless explicitly requested.
- Preserve upstream attribution and licensing adjacent to copied test material.
