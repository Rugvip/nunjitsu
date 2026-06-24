# Testing

The default test command validates source behavior, compatibility, security,
benchmarks, package builds, declarations, and both module formats:

```sh
pnpm test
```

Development requires Node.js 22.18 or newer and the pnpm version pinned in
`package.json`.

## Test layers

| Layer | Location | Purpose |
| --- | --- | --- |
| Source | `tests/source/` | Parser, interpreter, public API, security, and release tooling |
| Compatibility | `tests/compat/` | Attributed Nunjucks v3.2.4 cases and coverage mapping |
| Package | `tests/package/` | Built ESM, CommonJS, exports, and TypeScript declarations |
| Benchmarks | `benchmarks/` | Output-equivalent inline rendering against pinned Nunjucks |

Useful focused commands are:

```sh
pnpm test:source
pnpm typecheck
pnpm test:package
pnpm benchmark:quick
```

## Adding coverage

Put ordinary rendering parity in `tests/compat/cases.json`. This keeps the case
language-neutral and runs it against both Nunjitsu and pinned Nunjucks. Update
the manifest or coverage mapping whenever an upstream case changes
classification.

Use `tests/source/` when a case needs registered capabilities, non-JSON values,
errors, resource limits, or security-boundary assertions. Security failures
should prove that no later capability executes, no partial output is returned,
and a subsequent render starts cleanly.

Use `tests/package/` only for behavior that depends on the built package:
exports, module resolution, declarations, or ESM/CommonJS interoperability.

## Compatibility inventory

The inventory is pinned to Nunjucks v3.2.4. When intentionally changing that
baseline or regenerating its inventory, verify it against an exact upstream
checkout with:

```sh
node scripts/compat/verifyNunjucksInventory.mjs <path-to-nunjucks-v3.2.4>
```

Never mark an upstream case skipped without a manifest entry and a reason tied
to the documented compatibility contract.

## Benchmarks

Run the full comparison with:

```sh
pnpm benchmark
```

The harness measures fresh inline parsing and rendering in isolated processes.
Cases cover static and comment-heavy templates, expressions, lookups, macros,
built-in filters, and evolving prepared contexts. Nunjitsu and Nunjucks must
produce equivalent output for every comparison.

Benchmark timings are diagnostic, not pass/fail thresholds. The CI smoke run
checks correctness and harness health without asserting noisy performance
ratios.

## Continuous integration

GitHub Actions runs `pnpm test` on Node.js 22 and 24 for pull requests and
pushes to `main`. CI installs from the lockfile with read-only repository
permissions. Publishing uses separate release workflows and credentials.
