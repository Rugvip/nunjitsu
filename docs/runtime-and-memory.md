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

Macro and call-block declarations apply a stricter policy than ordinary call
arguments: positional formals must be symbols and default keys must be
parser-created allowed names. Ordinary formals are stored before the defaulted
formal map, matching Nunjucks even when a positional formal follows a default
in source. Ordinary calls similarly collect positionals separately and permit
them after keywords. Structural stop tags are validated in full rather than by
their first word; named block closers must match, and raw or verbatim openers
must be argument-free before the scanner enters raw mode.

Expression nodes encode the observable result of Nunjucks's parser and
generated-JavaScript grouping without generating or executing JavaScript.
Exponentiation chains associate left. Concatenation, addition, and subtraction
form one left-associative emitted tier. Floor division becomes an explicit
closed floor node around the multiplicative sequence that Nunjucks would place
inside `Math.floor`, including adjacent modulo operations. Parenthesized groups
remain explicit AST boundaries, and evaluator traversal preserves source-order
operand and capability evaluation.

## Closed values

The interpreter owns all values:

- undefined, null, booleans, numbers, and strings;
- arrays of engine values;
- records backed by private string-keyed maps;
- regular-expression literals represented as inert pattern/flag data; and
- sealed callable variants created by the interpreter.

String semantics follow Nunjucks and JavaScript UTF-16 code units consistently.
Length, numeric lookup, loops, `list`, edge selection, reversal, replacement,
and slicing may therefore expose the two surrogate halves of an astral code
point separately. Primitive strings are iterated by numeric index rather than
through `String.prototype[Symbol.iterator]`. Relational comparisons use direct
UTF-16 lexical ordering without locale or ICU collation, so results are stable
across supported Node.js environments. Chained comparisons retain Nunjucks's
left-associative JavaScript semantics.

Closed coercion is separate from output rendering. Output continues to render
null and undefined as empty strings, while semantic string and property-key
conversion produces `"null"` and `"undefined"`. Safe strings unwrap directly;
arrays convert by recursively joining closed item strings with commas; records
convert to the fixed string `"[object Object]"`; and regex values convert to
their inert `/source/flags` spelling. Callable coercion fails closed before any
callable nested in an array or record can be rendered, serialized, captured,
used as a separator, transformed by the standard library, or included in
scratch accounting. No path invokes a host object's iteration, `valueOf`,
`toString`, or primitive-conversion hook.

Built-in filters and tests declare their accepted closed input kinds directly.
Collection operations distinguish arrays, UTF-16 string sequences, nullish
errors, and the few pinned scalar-empty cases rather than treating every invalid
input as an empty collection. Text filters separately model Nunjucks's
false/nullish-to-empty normalization and its strict string-only operations.
Supported keyword arguments are resolved by map presence, preserving explicit
nullish values. Safe strings remain engine-owned text for these operations;
Nunjitsu does not reproduce accidental indexed-property gaps from Nunjucks's
JavaScript `String` wrapper implementation. The `string` filter rejects nullish
input, `length` preserves absent results for unsupported scalars, and
`urlencode` applies closed numeric pair lookup to every sequence entry rather
than silently discarding malformed entries.

Property lookup, derived record keys, membership, unary and binary arithmetic,
addition, concatenation, relational operators and tests, and loose equality all
use these centralized conversions. Array and string indexing accepts only an
in-range canonical nonnegative integer property key such as `"0"` or `"1"`;
empty, padded, decimal, exponent, whitespace, nullish, and boolean strings are
not indices. Numeric negative zero becomes the canonical key `"0"`. The
`"length"` property is available through primitive and safe-string keys.

Strict equality is direct primitive or interpreter-object identity. Loose
equality first preserves object identity, then applies closed object-to-primitive
conversion only when one side is primitive. Distinct safe strings, arrays,
records, regex values, and callables remain unequal regardless of content.
Array membership is separately strict and never unwraps safe strings or other
closed objects. Switch cases use the same strict identity operation, preserving
primitive type distinctions, `NaN` behavior, signed-zero equality, and exact
closed reference identity without host coercion.

Expression grouping follows Nunjucks's observable generated behavior, including
its non-conventional cases. Relational operators bind above equality;
membership and tests are separate grouping boundaries; and prefix `not` is
lowered through the left operand of raw arithmetic, concatenation, and
comparison expressions while stopping at floor division, power, filters,
membership, tests, and explicit groups. Nested inline conditionals in an else
arm require explicit parentheses. Dictionary literal keys accept only strings
and ordinary identifiers so invalid key forms fail during complete-source
parsing, before evaluation or capability dispatch.

Input arrays and records are recursively copied. Records are never used as
JavaScript prototypes or accessed through `object[key]` inside the interpreter.
`constructor`, `prototype`, and `__proto__` are reserved throughout parsing,
copying, scopes, lookup, assignment, registries, and callback results.
Node-detected proxies, including revoked and nested proxies, are rejected before
array detection or reflective inspection, so copying never invokes their traps.

One-shot renders discard their copied value graph after rendering. Callers that
render several sources against the same data may explicitly prepare an opaque,
engine-bound context snapshot. Derived path updates copy the new public value
and the map-backed records on that path while structurally sharing unchanged
closed values. Snapshots are immutable: evaluator scopes and template
assignments never update them.

Parser-validated constant attribute and index keys use a narrowed closed lookup
operation. Computed keys continue through explicit runtime coercion. Both paths
dispatch only over internal value kinds and reserve prototype gadget names.

Loops and membership checks iterate internal collections directly. Loop
planning uses both the container kind and the number of flat symbol targets.
With one target, arrays and strings yield their values, while records emulate
Nunjucks's array-like path using only the record's own raw `length` and numeric
entries. That raw length remains visible as `loop.length`, drives the generated
metadata arithmetic through closed numeric conversion, and independently
controls `{% else %}` through closed truthiness. It is not normalized to the
number of iterations, preserving string, negative, and fractional-length
behavior.

With multiple targets, arrays yield elements for closed numeric destructuring,
records lazily yield key-value pairs, primitive strings yield index and UTF-16
code-unit pairs, and top-level safe strings follow Nunjucks's iterator-to-array
path. Numeric destructuring dispatches only over interpreter arrays, primitive
strings, and record entries. Numbers and booleans produce undefined bindings;
null and undefined fail before the loop body executes. No path invokes a host
property, iterator, getter, coercion hook, or prototype. Potentially unbounded
array-like record lengths remain bounded by normal evaluator work limits.

Record membership uses the map-backed presence operation rather than the
retrieved value, so a present key containing the interpreter's `undefined`
value remains present. String loops consume one UTF-16 code unit per iteration.
Binding syntax is restricted to one ordinary symbol or a flat comma-separated
symbol list; bracketed, grouped, nested, literal, lookup, and callable targets
fail during complete-source parsing before any capability can run.

The `random` filter selects array indices synchronously with Node's
cryptographic random source. It never reads or advances the caller realm's
shared `Math.random` stream.

## Scopes and calls

Lexical scopes are engine-owned frames with one private map of value and
writability entries plus explicit parent links. Calls dispatch only to inline
macros, interpreter built-ins, or exact registered global-function identities.
Context functions, methods, constructors, and looked-up values are never
callable.

Each directly resolved registered or built-in global has one canonical sealed
handle within a render. Scope assignments, loop bindings, direct equality,
membership, tests, and switch matching retain that handle identity. Ordinary
array and record member lookup instead returns a new sealed alias containing
only the same evaluator-owned callable kind and opaque ID, reproducing
Nunjucks's fresh bound-function identity without creating authority, storing a
receiver, or exposing a host function. Callable-valued built-in members follow
the same rule, while stateful method lookup remains fresh. These maps and
handles belong to one evaluator and are discarded after the render.

Macro binding assigns each positional value only to the formal parameter at the
same index, then consults the matching keyword only when that position is
absent. Positional values take Nunjucks-compatible precedence when both forms
target one parameter. Explicit `null`, absent-value `undefined`, `false`, zero,
and empty strings remain supplied values. A default expression is evaluated
only when neither the formal position nor its keyword was supplied, so defaults
cannot introduce capability side effects for explicit values.

When a declaration repeats a formal name, the first formal owns the visible
binding. Later duplicates still consume their formal positions and evaluate a
genuinely needed default, but cannot overwrite that first binding. This
reproduces Nunjucks's generated declaration behavior without weakening the
closed scope model.

Undeclared keyword arguments do not become macro locals. The sole exception is
the `caller` keyword synthesized by call blocks, which is installed explicitly
when the macro does not declare a `caller` parameter. This preserves call-block
semantics without allowing arbitrary keyword names to inject closed values or
callable identities into a macro scope.

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
guard and is intentionally UTF-16 code-unit rather than exact byte accounting.
Nesting depth is checked before evaluating each statement and expression node.
These are cooperative availability safeguards, not a process sandbox or exact
CPU/RSS accounting.
Trusted callbacks execute outside interpreter work accounting except for their
invocation count and returned-value validation. Callback return validation is
inside the fail-stop capability exception boundary.

Every registered filter and global boundary clears the host realm's legacy
RegExp capture fields immediately before copying arguments and again in a
`finally` block after callback execution, result validation, or sanitized
exception handling. A capability therefore cannot observe template parsing or
runtime match state, and one capability cannot pass match state to another.
Nested renders apply the same boundary independently.

All parser, evaluator, built-in, and capability exits additionally converge on
the public render `finally` boundary, which repeats the deterministic reset as
defense in depth. These boundaries clear rather than retain or restore ambient
match state.

Expected parser and evaluator failures are reduced to engine-owned diagnostic
data before crossing the public boundary. The public render error carries a
bounded message, stable phase and code, and the deepest available one-based
template line and column. It never retains an internal error or stack as its
cause. This keeps diagnostics useful for template authors without making
logging or recursive inspection another path for untrusted source text.
