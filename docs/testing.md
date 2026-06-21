# Testing

## Test layers

1. Parser tests cover the closed grammar, fixed delimiters, malformed
   input, complete validation, and immutable data-only ASTs.
2. Interpreter tests cover copied values, scopes, lookup, coercion, operators,
   calls, limits, output, and cleanup.
3. Compatibility tests execute applicable attributed Nunjucks v3.2.4 behavior
   through the secure direct-string API.
4. Public API tests cover filters, globals, rendering modes, errors, and both
   ESM and CommonJS package entry points.
5. Security tests exercise JavaScript escape gadgets, prototype pollution,
   accessors, exotic values, callback results, and parser fuzzing.
6. Benchmarks compare synchronous inline parsing and expression evaluation with
   pinned Nunjucks in isolated processes.

## Compatibility corpus

`tests/compat/cases.json` contains data-only cases adapted from Nunjucks 3.2.4.
The manifest retains provenance for all upstream cases and marks behavior
outside the secure direct-string contract as not applicable. Applicable cases
must render through the same synchronous public API used by applications.
Every ported or adapted manifest entry must have executable coverage. Pure
rendering belongs in the language-neutral case corpus; behavior requiring
trusted capabilities, non-JSON fixtures, errors, or boundary assertions may
link to an exact source test through `tests/compat/coverage.json`. Validation
also requires reasons for every adapted or inapplicable classification. The
language-neutral cases execute against both Nunjitsu and the pinned Nunjucks
development oracle so expected output cannot drift independently.

## Security regression suite

The suite covers reserved prototype names, ambient Node globals, constructor
gadgets, method calls, implicit coercion, accessors, exotic objects, cyclic
values, capability identity confusion, malformed syntax, and state cleanup
after failures. Static checks reject dynamic execution and host reflection in
parser and interpreter modules.

## Fuzzing

Tokenizer, parser, input copier, and evaluator are fuzz targets. Arbitrary
source must either produce a bounded data-only AST or a structured error;
parsing must never execute host behavior; evaluation must only access closed
value kinds; and failures must leave the next render clean.

## Benchmarks

The comparison harness renders output-equivalent workloads in separate
processes with fresh parsing on every operation. The cases cover independent
comment-heavy templates, computed expressions, many distinct tiny templates,
deep constant and computed lookups, macro and scope churn, built-in filter
pipelines, and repeated rendering while a prepared context evolves. Context
preparation is reported as setup rather than repeated rendering work; the
evolving case measures each immutable path update and following render.
By default, the harness runs 10 loops over the complete case list. Each
case/engine pair starts in fresh isolated workers during every loop and performs
20 warmup operations followed by 100 individually timed operations. Median,
p95, mean, and throughput use all 1,000 raw timing samples per case and engine
rather than first aggregating the samples within each loop. Reported setup and
retained memory are averages across loop workers; peak RSS is their maximum.
Callback benchmarks are intentionally excluded because the direct-string API
is synchronous and callback overhead is not a separate target.
