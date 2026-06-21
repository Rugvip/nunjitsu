# Testing

## Test layers

Nunjitsu uses one implementation-independent compatibility corpus and focused
tests around its security boundaries:

1. **Tokenizer and parser tests** cover the closed grammar, source spans,
   malformed input, complete validation, and immutable data-only ASTs.
2. **Value and interpreter tests** cover copying, scopes, lookup, coercion,
   operators, calls, limits, output, and cleanup.
3. **Shared compatibility tests** execute the attributed Nunjucks v3.2.4 cases
   through the native TypeScript engine.
4. **Public API tests** cover loaders, capabilities, streaming, cancellation,
   errors, and both ESM and CommonJS package entry points.
5. **Security tests** exercise known JavaScript escape gadgets, prototype
   pollution, accessors, exotic values, capability results, and parser fuzzing.
6. **Benchmarks** compare equivalent one-shot workloads with caching disabled
   in Nunjucks.

## Shared compatibility corpus

`tests/compat/cases.json` is language-neutral source data adapted from Nunjucks
v3.2.4. Tests keep that source data stable while adapting harness code to the
native API. Every upstream case remains classified in the parity manifest with
provenance and an explicit reason for exclusions or intentional security
deviations.

Avoid duplicating semantic cases across layers. Parser-only assertions may
reuse the same template source while runtime and public API tests assert the
observable output.

## Security regression suite

The suite includes, at minimum:

- `constructor.constructor`, `prototype`, and `__proto__` through dotted,
  bracket, literal, assignment, registry, context, and callback-result paths;
- attempts to resolve `globalThis`, `process`, `require`, `module`, `eval`,
  JavaScript constructors, and dynamic imports;
- method calls and implicit coercion through `toString`, `valueOf`, iterators,
  symbols, and getters;
- polluted prototypes, class instances, accessors, cycles, excessive depth,
  and unsupported exotic objects;
- capability identity confusion and unsafe callback-result aliases; and
- malformed syntax around every call, lookup, literal, and custom-tag grammar.

Tests demonstrate that rejected accessors are not invoked. Template-visible
records and scopes remain unaffected by `Object.prototype` mutation.

Static project checks reject prohibited dynamic execution and host reflection
inside parser and interpreter modules. These checks complement runtime tests;
they do not replace code review.

## Fuzzing

Tokenizer, parser, input copier, and evaluator are fuzz targets. Useful
invariants include:

- arbitrary template text either produces a bounded data-only AST or a
  structured parse error;
- parsing never executes host behavior;
- evaluation accesses only internal value kinds and sealed callable variants;
- work, depth, growth, and output counters fail deterministically; and
- failure or cancellation leaves no state observable by the next render.

## Benchmarks

Benchmark output remains equivalent across Nunjitsu and pinned Nunjucks. The
harness uses separate processes, disables Nunjucks caching, reports setup and
render time independently, and never turns noisy measurements into pass/fail
thresholds.

The checked-in workloads retain their existing source data:

- `template-graph` parses inheritance, includes, loops, and dense comments;
- `expressions` stresses arithmetic, comparisons, membership, lookup, and
  concatenation; and
- `capabilities` invokes synchronous and asynchronous filters, tests, and
  globals.
