# Runtime and interpreter

## Execution model

Nunjitsu executes a synchronous native TypeScript interpreter in the caller
process. Security comes from interpreting a closed grammar over copied values.
The runtime never uses `eval`, `Function`, `vm`, generated JavaScript, dynamic
imports, or a JavaScript parser to execute expressions.

## Complete data-only AST

Each inline source is fully parsed before execution. Template and expression
nodes are closed discriminated unions containing only primitives, child nodes,
and arrays of nodes. They cannot contain callbacks, descriptors, host values,
or executable closures.

The parser validates every node field shape across the complete tree before
returning it. Evaluator field access trusts that private immutable result and
does not repeat structural validation while executing loops.

Full parsing reports syntax errors in inactive branches and unused macros.
Template-loading and extension nodes are rejected. No AST or source survives a
render.

## Closed values

The interpreter owns all values:

- undefined, null, booleans, numbers, and strings;
- arrays of engine values;
- records backed by private string-keyed maps;
- regular-expression literals represented as inert pattern/flag data; and
- sealed callable variants created by the interpreter.

Input arrays and records are recursively copied. Records are never used as
JavaScript prototypes or accessed through `object[key]` inside the interpreter.
`constructor`, `prototype`, and `__proto__` are reserved throughout parsing,
copying, scopes, lookup, assignment, registries, and callback results.

One-shot renders discard their copied value graph after rendering. Callers that
render several sources against the same data may explicitly prepare an opaque,
engine-bound context snapshot. Derived path updates copy the new public value
and the map-backed records on that path while structurally sharing unchanged
closed values. Snapshots are immutable: evaluator scopes and template
assignments never update them.

Parser-validated constant attribute and index keys use a narrowed closed lookup
operation. Computed keys continue through explicit runtime coercion. Both paths
dispatch only over internal value kinds and reserve prototype gadget names.

Loops and membership checks iterate internal collections directly. They do not
materialize a second array containing the full collection; record loop pairs
are created one at a time as the interpreter consumes them.

## Scopes and calls

Lexical scopes are engine-owned frames with one private map of value and
writability entries plus explicit parent links. Calls dispatch only to inline
macros, interpreter built-ins, or exact registered global-function identities.
Context functions, methods, constructors, and looked-up values are never
callable.

## Output

Evaluation collects string chunks in a render-owned buffer and returns their
joined value. Automatic escaping is disabled to match Backstage. Explicit
Nunjucks filters such as `escape` still provide their documented behavior.
Rendered output remains attacker-controlled and is not a general HTML, SQL, or
shell sanitizer.

## Cooperative limits

High finite limits account for source characters, AST nodes, evaluator work,
interpreter nesting depth, allocation, output, and capability calls. Nesting
depth is checked before evaluating each statement and expression node. These
are cooperative availability safeguards, not a process sandbox or exact
CPU/RSS accounting. Trusted callbacks execute outside interpreter work
accounting except for their invocation count and returned-value validation.
