# Testing

## Test layers

1. Parser tests cover the closed grammar, fixed delimiters, malformed
   input, complete validation, and immutable data-only ASTs.
2. Interpreter tests cover copied values, scopes, lookup, coercion, operators,
   calls, limits, output, and cleanup.
3. Compatibility tests execute applicable attributed Nunjucks v3.2.4 behavior
   through the secure direct-string API.
4. Public API tests cover filters, globals, rendering modes, errors, ESM and
   CommonJS package conditions, cross-format loading, and declarations through
   modern NodeNext, bundler, and legacy TypeScript resolution.
5. Security tests exercise JavaScript escape gadgets, prototype pollution,
   accessors, exotic values, callback results, malformed syntax, and static
   checks for prohibited implementation primitives.
6. Benchmarks compare synchronous inline parsing and expression evaluation with
   pinned Nunjucks in isolated processes.

## Continuous integration

GitHub Actions runs the complete test matrix on the current Node.js 22 and 24
releases for every pull request and every push to `main`.

All CI matrix jobs install with the `packageManager`-pinned pnpm version and
`pnpm install --frozen-lockfile`. CI has read-only repository permissions,
cancels superseded runs for the same ref, and does not receive publishing
permissions or credentials.

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
values, trap-free rejection of nested and revoked proxies, inherited iteration
and serialization hooks, capability identity confusion, fixed-position macro
binding, undeclared keyword isolation, undefined-valued record membership,
UTF-16 string operations, deterministic ordering, and isolated surrogate
handling, strict and loose equality, malformed syntax, public error
classification, centralized coercion and canonical indices, diagnostic control
characters, explicit coverage of every Unicode `Bidi_Control` character, and
truncation, inert capability exception handling, legacy RegExp state isolation
at capability and nested-render boundaries, render-exit cleanup, mixed-operator
grouping and operand order, comparison, membership, test, and prefix-`not`
grouping, nested inline-conditional and dictionary-key parser acceptance,
parenthesized comma-expression value selection, side-effect order, empty-group
rejection, and callable-discard prevention,
`elif`/`elseif` block chains and malformed continuation rejection,
container- and target-sensitive loop planning, raw record-length metadata,
flat-target validation, nullish destructuring failures before capability
dispatch, canonical and fresh-member callable identities, strict switch
matching and case evaluation order, arm-free switch rejection, empty-arm and
fallthrough preservation, callable-boundary rejection, structured
cause-free public diagnostics, declaration-specific formal validation,
lexical macro export and invocation frames across root, blocks, loops, macros,
callers, conditionals, and switches, plus capture-declaration rejection,
exact dotted-filter capability dispatch and registry-name rejection,
filter-block AST lowering, body-before-argument ordering, fail-before-capture
validation, nested capture, and package-entrypoint dispatch,
post-default and post-keyword positional ordering, structural-tag remainder and
named-block checks, raw-mode entry validation, and render state cleanup after
failures. Repeated-unary regressions cover active and inactive expressions,
defaults, arguments, collections, arithmetic nesting, both delimiter modes,
valid grouping, and zero capability dispatch. Standard-library regressions
compare collection and text input domains,
nullish failure behavior, scalar length results, URL-encoding pair lookup,
safe-string adaptations, keyword arguments, stateful globals, capability order,
callable-laundering attempts, and type preservation across `range`, `sum`, and
`joiner`. Shared numeric-filter cases cover original-value defaults, fractional
repeat bounds, substring and replacement limits, URL label lengths, fractional
precision, and number/string JSON indentation. Standalone-block tests cover
unresolved `super`, alias/container and capture paths, configured-name
behavior, macro-only call-block targets, and caller-handle confinement.
Validation-order tests cover effectful call-block
targets, non-macro targets, unknown filters and tests, empty selection inputs,
known-operation operand order, ignored attribute-selection arguments, no partial
output, and clean recovery. Call-block signature regressions compare regex
parentheses, nested expression containers, division ambiguity, malformed regex
fail-stop behavior, and both variable-delimiter modes against the pinned oracle.
Callable-argument tests cover direct, nested, renamed, positional, and surplus
handles across registered capabilities, finite and disabled scratch accounting,
stateful built-ins, ignored method arguments, and exact test arity while
retaining valid macro forwarding and identity checks. Static checks reject
dynamic execution and host reflection in parser and interpreter modules.

## Fuzzing policy

The tokenizer, parser, input copier, and evaluator are appropriate fuzz targets
for security-sensitive changes. Added fuzz coverage must assert that arbitrary
source either produces a bounded data-only AST or a structured error, parsing
never executes host behavior, evaluation accesses only closed value kinds, and
failures leave the next render clean. Fuzz artifacts remain local build output;
stable regressions belong in the source test suite.

## Benchmarks

The comparison harness renders output-equivalent workloads in separate
processes with fresh parsing on every operation. The cases cover independent
comment-heavy templates, computed expressions, many distinct tiny templates,
deep constant and computed lookups, macro and scope churn, built-in filter
pipelines, and repeated rendering while a prepared context evolves. Context
preparation is reported as setup rather than repeated rendering work; the
evolving case measures each immutable path update and following render. Public
and internal prepared-context tests distinguish a missing path segment from a
present `undefined` value and verify failed updates leave snapshots unchanged.
By default, the harness runs 10 loops over the complete case list. Each
case/engine pair starts in fresh isolated workers during every loop and performs
20 warmup operations followed by 100 individually timed operations. Median,
p95, mean, and throughput use all 1,000 raw timing samples per case and engine
rather than first aggregating the samples within each loop. Reported setup and
retained memory are averages across loop workers; peak RSS is their maximum.
Callback benchmarks are intentionally excluded because the direct-string API
is synchronous and callback overhead is not a separate target.
