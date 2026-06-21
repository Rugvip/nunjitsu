# Testing

## Test layers

1. Parser tests cover the closed grammar, Backstage delimiters, malformed
   input, complete validation, and immutable data-only ASTs.
2. Interpreter tests cover copied values, scopes, lookup, coercion, operators,
   calls, limits, output, and cleanup.
3. Compatibility tests execute applicable attributed Nunjucks v3.2.4 behavior
   through the Backstage-focused API.
4. Public API tests cover filters, globals, rendering modes, errors, and both
   ESM and CommonJS package entry points.
5. Security tests exercise JavaScript escape gadgets, prototype pollution,
   accessors, exotic values, callback results, and parser fuzzing.

## Compatibility corpus

`tests/compat/cases.json` contains data-only cases adapted from Nunjucks 3.2.4.
The manifest retains provenance for all upstream cases and marks behavior
outside the Backstage contract as not applicable. Applicable cases must render
through the same synchronous public API used by the scaffolder integration.

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
