# Runtime and interpreter

## Execution model

Nunjitsu executes a synchronous native TypeScript interpreter in the caller
process. Security comes from interpreting a closed grammar over copied values.
The runtime never uses `eval`, `Function`, `vm`, generated JavaScript, dynamic
imports, or a JavaScript parser to execute expressions.

## Complete data-only AST

Each inline source is fully parsed before execution. Template and expression
nodes are frozen object-based discriminated unions containing only primitives,
direct child references, and frozen arrays of nodes. Stable variants expose
direct typed properties rather than generic field maps or packed storage. They
cannot contain callbacks, descriptors, host values, or executable closures.

The native parser can construct only closed node variants and freezes each one
before returning it. Evaluator property access trusts that private immutable
result and does not repeat structural validation while executing loops. Node
creation charges the AST limit immediately, rather than traversing an
unbounded tree after parsing.

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

Macro binding tracks whether each keyword or positional argument was supplied
separately from its runtime value. Explicit `null`, absent-value `undefined`,
`false`, zero, and empty strings remain supplied values. A default expression
is evaluated only when neither a keyword nor positional argument was provided,
so defaults cannot introduce capability side effects for explicit values.

## Output

Evaluation appends string slices to a render-owned array and joins it once at
the end. Automatic escaping is disabled for the direct-string API. Native
standard-library filters such as `escape` still provide their documented
behavior. Rendered output remains attacker-controlled and is not a general
HTML, SQL, or shell sanitizer.

## Cooperative limits

High finite limits account for source code units, AST nodes, evaluator work,
interpreter nesting depth, rendered output code units, filter-argument scratch
size, and capability calls. The scratch limit estimates the UTF-8 size of the
closed values passed into a filter; it is not a general allocation or heap
limit. Output growth uses JavaScript string length as a cheap memory-pressure
guard and is intentionally not exact byte accounting. Nesting depth is checked
before evaluating each statement and expression node. These are cooperative
availability safeguards, not a process sandbox or exact CPU/RSS accounting.
Trusted callbacks execute outside interpreter work accounting except for their
invocation count and returned-value validation.
