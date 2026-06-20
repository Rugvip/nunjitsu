# Testing

## Test layers

Nunjitsu uses a small number of thorough suites with clear ownership:

1. **Rust unit and property tests** cover lexing, parsing, safe values, arena
   records, evaluator semantics, budgets, and cleanup. They run natively where
   possible for speed.
2. **Wasm ABI tests** compile the production artifact and exercise versioning,
   offset validation, state transitions, continuation handling, cancellation,
   and malformed host data.
3. **Shared compatibility tests** execute the attributed Nunjucks v3.2.4 corpus
   directly against Rust behavior and through the TypeScript engine.
4. **TypeScript source tests** run erasable `.ts` directly on the minimum
   supported Node version.
5. **Package contract tests** build the package and exercise both ESM `import`
   and CommonJS `require`, including worker startup, Wasm loading, rendering,
   streaming, and disposal.

Avoid duplicating the full compatibility suite in each layer. Shared cases are
the behavioral source; layer-specific tests should concentrate on that layer's
boundary and failure modes.

Cases that require the production Wasm evaluator or an asynchronous host mark
`nativeRender: false`. They still execute through Rust/Wasm in the TypeScript
host harness; the small native renderer runs the remaining portable subset
directly.

## Compatibility corpus

The `tests/compat/` directory owns:

- the copied/adapted template fixtures;
- a tagged, language-neutral case format;
- the parity manifest for every upstream v3.2.4 test;
- named loader/capability fixtures implemented equivalently by each harness;
  and
- the upstream BSD-2-Clause license and attribution.

The case format must represent Nunjucks-specific distinctions that ordinary
JSON loses, including `undefined`, safe strings, non-finite numbers, and
expected failures. It must not embed executable JavaScript as the source of
expected behavior.

Every manifest entry identifies its upstream file and test name. Adapted and
not-applicable entries include a reason tied to
[the compatibility contract](compatibility.md). CI fails on unclassified
upstream tests, missing fixtures, or cases that only one implementation layer
executes without an explicit reason.

`upstream-inventory.json` is a checked-in inventory of all 364 Mocha cases in
the pinned release. It is regenerated only from an explicit v3.2.4 checkout by
`scripts/import-nunjucks-inventory.mjs`; CI never fetches upstream. While the
port is incomplete, `manifest.json` declares `coverage: "partial"`. A release
requires `coverage: "complete"`, one classification for every inventory entry,
and no dangling or duplicate case mappings.

## Security tests

Security tests must cover behavior, not just successful isolation:

- prototype, getter, function, exotic-object, and cycle rejection;
- filesystem traversal and canonical-root enforcement;
- evaluator, nesting, output, memory, and capability budgets;
- cancellation at parser, evaluator, output, and callback yield points;
- stale continuation responses and render-epoch offsets;
- worker cleanup after callback failure or malformed ABI data; and
- explicit unlimited-limit opt-out behavior.

Tests must demonstrate that a failed or cancelled render cannot affect the next
render assigned to the same worker.

## Fuzzing and property testing

The lexer, parser, heterogeneous record decoder, safe-value decoder, and raw ABI
are fuzzing targets. Useful invariants include:

- malformed input never causes out-of-bounds memory access or panic across the
  host boundary;
- every accepted record round-trips through its canonical encoding;
- cleanup invalidates all prior offsets and continuations; and
- resource accounting is monotonic and cannot overflow into a lower value.

Fuzz regressions become permanent focused tests.

## Performance tests

Benchmarks must represent the stated optimization target: cold or infrequent
renders, worker reuse without template reuse, bounded output, and memory
returned after outliers. Report retained bytes and allocation high-water marks
alongside elapsed time. Do not improve repeated-template throughput by adding a
persistent source, AST, or compiled cache contrary to the architecture.
