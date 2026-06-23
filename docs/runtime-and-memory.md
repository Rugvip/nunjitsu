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
must be argument-free before the scanner enters raw mode. A call block remains
a dedicated statement node rather than being lowered to an ordinary call with
a hidden argument. Its target must be a direct symbol or a static constant-key
lookup rooted at one, so target validation cannot execute another call, filter,
or computed lookup. Its optional caller signature is split with the shared
balanced code scanner, which ignores delimiters inside parser-owned strings and
regex literals before the expression parser validates the resulting defaults.

Expression nodes encode the observable result of Nunjucks's parser and
generated-JavaScript grouping without generating or executing JavaScript.
Exponentiation chains associate left. Concatenation, addition, and subtraction
form one left-associative emitted tier. Floor division becomes an explicit
closed floor node around the multiplicative sequence that Nunjucks would place
inside `Math.floor`, including adjacent modulo operations. Parenthesized groups
remain explicit AST boundaries, and evaluator traversal preserves source-order
operand and capability evaluation.

Repeated unparenthesized unary signs follow Nunjucks's observable compiler
restriction. A `Neg` node cannot directly contain another `Neg`, and a `Pos`
node cannot directly contain another `Pos`, because Nunjucks emits those pairs
as invalid JavaScript update operators. Alternating signs remain valid, as do
repeated signs separated by an explicit `Group` and repeated `not` expressions.
The parser rejects the invalid direct-child shape while parsing the complete
source, before any active or inactive expression can execute.

Parenthesized comma-separated expressions remain explicit `Group` nodes. The
evaluator visits each child once from left to right and returns only the final
value, matching Nunjucks's observable comma-expression behavior. Every
non-final value is checked recursively for callable identity before discard;
the final value retains its ordinary closed type and may remain callable.
Empty groups are rejected while parsing the complete source.

String tokenization implements the pinned Nunjucks escape grammar directly in
the closed parser. It decodes only `\\n`, `\\t`, and `\\r`; every other
backslash escape retains the next source code unit without JavaScript-style
hexadecimal or Unicode decoding. Raw source positions are advanced code unit by
code unit so diagnostics after multiline strings retain the correct line and
column.

Numeric tokenization accepts only decimal digits with an optional decimal point
and following digits. It rejects leading dots and identifier-like suffixes
before emitting a numeric token, then converts only that validated token with
native number parsing. Signs remain explicit unary AST nodes, and supported
arithmetic remains the only route to non-finite values such as infinity.

## Closed values

The interpreter owns all values:

- undefined, null, booleans, numbers, and strings;
- sealed safe-string wrappers containing engine-owned text;
- arrays of engine values;
- records backed by private string-keyed maps with explicit JavaScript property
  enumeration order;
- regular-expression literals represented as inert pattern/flag data after a
  fixed parser-owned `gimy` flag and delimiter grammar has been validated; and
- sealed callable variants created by the interpreter.

String semantics follow Nunjucks and JavaScript UTF-16 code units consistently.
Length, numeric lookup, loops, `list`, edge selection, reversal, replacement,
and slicing may therefore expose the two surrogate halves of an astral code
point separately. Primitive strings are iterated by numeric index rather than
through `String.prototype[Symbol.iterator]`. Relational comparisons use direct
UTF-16 lexical ordering without locale or ICU collation, so results are stable
across supported Node.js environments. Chained comparisons retain Nunjucks's
left-associative JavaScript semantics.

Closed boolean conversion treats a safe-string wrapper as an object-like value,
so it remains truthy even when its text is empty. Explicit text operations do
not infer non-empty content from that result: length, indexing, iteration,
string conversion, and numeric conversion continue to inspect the wrapped text.
Filter flags and defaults use wrapper truthiness, while top-level empty-string
iteration still has a numeric content length of zero.

Closed coercion is separate from output rendering. Output continues to render
null and undefined as empty strings, while semantic string and property-key
conversion produces `"null"` and `"undefined"`. Safe strings unwrap directly;
arrays convert by recursively joining closed item strings with commas; records
convert to the fixed string `"[object Object]"`; and regex values convert to
their inert Nunjucks-compatible canonical spelling. Empty regex sources display
as `(?:)`, raw line terminators are escaped, and flags are ordered `gimy`. One
closed helper owns this display conversion for semantic coercion, output, and
capability copies without invoking a native or internal regex prototype hook.
The original source and flags remain separate for approved regex replacement.
Callable coercion fails closed before any callable nested in an array or record
can be rendered, serialized, captured, used as a separator, transformed by the
standard library, or included in scratch accounting. No path invokes a host
object's iteration, `valueOf`, `toString`, or primitive-conversion hook.

Numeric ordering performs explicit less-than, greater-than, and equality checks
after this closed primitive conversion. It does not subtract operands, because
equal positive or negative infinities must produce an ordering delta of zero.
Only genuinely unordered numeric comparisons involving `NaN` produce an
unordered result. Relational operators, ordering tests, length short-circuits,
sorting, ranges, and Jinja slice boundaries all share this rule.

`RuntimeRecord` owns enumeration order centrally. Canonical array-index names
from `0` through `2^32 - 2` enumerate first in ascending numeric order. Other
strings retain first-insertion order, and replacement preserves the existing
position. Construction and immutable `with` updates both reapply the rule;
consumers iterate the private map directly without converting it to a host
object or implementing their own numeric-key sort.

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

Array-like records remain records with an own raw `length` and canonical
numeric keys; they are not admitted to the shared array/string sequence helper.
Filters reproduce their individual indexed algorithms: direct edge lookup,
comparison-loop collection, map-style length assignment, slice-style presence
checks, or one cryptographically selected index. Missing positions become
closed `undefined` only on algorithms that perform a direct lookup. Native
array-method filters continue to reject records, while record-oriented filters
continue to enumerate record entries.

Attribute resolution is prepared per filter rather than by one shared path
normalizer. Direct-key filters apply closed property-key conversion once;
getter-path filters split only primitive strings and preserve safe strings or
other truthy values as one key. Closed own lookup distinguishes a missing entry
from an entry containing `undefined`, supports array and UTF-16 string indices
and length, and throws before further evaluation when a non-empty lookup reaches
null or undefined. It never follows a prototype, accessor, method, or host
object property.

Stateful and reducing built-ins retain closed value types while they operate.
`range` selects its short form when the stop value is absent, compares each
current value and step through closed ordering, and increments through closed
addition. `sum` reduces elements from numeric zero through closed addition and
only then adds the original start value. `joiner` retains its original truthy
separator value and returns that exact closed value after its first call.
Coercion therefore occurs only at a later operation that actually requires it.

Collection sorting keeps operation-specific comparison rules. `sort` applies
pairwise lowercase normalization only to string-like values and otherwise uses
closed relational coercion, with stable input order for equal or unordered
values. `dictsort` independently uppercases string operands, checks closed
greater-than and strict equality, then returns its pinned `-1` fallback. Neither
path invokes host object coercion or shares a generic text comparator.

Filter short-circuits preserve the closed value produced at that exact stage.
`replace` handles regex search before numeric input conversion, keeps the raw
replacement until its use requires coercion, and returns the coerced input
identity for zero limits or absent matches. Regex output is always an ordinary
string and non-string regex input fails. `center` and `truncate` compare a
closed direct-length value before requiring primitive or safe text, allowing
unchanged arrays and records to retain identity. `wordcount` applies closed
falsiness before its text requirement. Existing safe strings survive unchanged
`center`, `truncate`, and `string` paths by identity; transformed paths create
fresh safe-string values through explicit safeness copying.

Numeric filter arguments follow the same rule without sharing one generic
integer conversion. `center`, `indent`, and `truncate` select defaults from the
original closed value before numeric use. Spacing reproduces Nunjucks's finite
repeat-loop rounding with a hard bound; truncation uses closed numeric values at
the `substring` and `lastIndexOf` operations. Replacement preserves exact `-1`
as its unlimited sentinel and compares an integer counter against every other
bound without pre-truncation. URL labels model `substr`, round precision flows
directly into exponentiation, and JSON indentation accepts only closed number
or string values with native JSON limits. The stricter positive-integer input
contracts for `batch` and `slice` remain intentional security deviations.

Built-in mode and formatting selectors do not share general string coercion.
`dictsort` validates its original closed selector as absent, primitive `key`,
or primitive `value`. `round` compares the original method value directly with
primitive `ceil` and `floor`. JSON indentation admits only primitive strings or
numbers; a safe-string wrapper is ordinary closed data rather than a native
boxed string with a JavaScript internal string slot.

JSON conversion materializes arrays and records as transient null-prototype
containers. An inert `RuntimeRegex` becomes a fresh empty null-prototype record,
which reproduces native RegExp's empty enumerable JSON shape without creating a
native RegExp or exposing its source and flags. Callable identities remain
rejected, while `undefined`, non-finite numbers, and other primitives retain
their native JSON behavior.

Filter argument evaluation retains the parser's Nunjucks aggregate order:
positional expressions are evaluated first, followed by keyword expressions.
Only `int` and `sort` consume declared names from the keyword map. Before every
other built-in runs, the evaluator lowers the map into one final positional
`RuntimeRecord`, forces its `__keywords` entry to true, and includes that closed
record in scratch accounting. No native JavaScript keyword object, prototype,
property lookup, or getter participates in dispatch.

Jinja subscript slices retain the evaluated target and operate through closed
direct length and own-key lookup. Bounds are not truncated or clamped. Negative
start and stop values add the raw length once, the upper boundary rejects only
indices greater than length, and each next index is produced by closed
JavaScript-style addition with the original step. Missing canonical,
fractional, padded, or concatenated string keys append `undefined`. Every
attempted result consumes evaluator work and an indexed scratch slot before it
is stored; selected callable values fail immediately. A step is accepted only
when closed numeric coercion is finite and nonzero.

Standalone blocks retain only the isolated scope needed to evaluate their own
body and to bind macros with Nunjucks-compatible scope behavior. The evaluator
has no parent-definition chains, block indices, inheritance merging, or sealed
`super` callable. An unresolved `super()` therefore fails like any unknown call
target. Applications may explicitly register a global named `super`; it then
resolves only as that ordinary capability. Call-block syntax targets template
macros exclusively, and the synthesized `caller` handle remains macro-local.

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

Switch parsing requires at least one `case` or `default` structural arm after
comments are removed. Arm bodies may be empty, and consecutive empty cases
retain Nunjucks fallthrough behavior. An arm-free switch is rejected before any
node from the complete source can execute.

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
closed values. Missing intermediate keys create records, while every present
non-record value—including explicit `undefined`—rejects further traversal;
presence is checked independently from the stored value. Replacing the final
path entry directly remains valid. Snapshots are immutable: evaluator scopes
and template assignments never update them.

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

Macro binding uses a separate immutable lexical context containing a name-
binding scope and an invocation-parent scope. Root and standalone block frames
export names to the template scope, including nested blocks and blocks reached
from loops. Ordinary macro bodies use the same export frame. Loop bodies and
synthetic caller bodies bind macros locally, but ordinary macros declared there
still invoke against the template scope and cannot capture loop, caller, or
outer-macro locals. `if` and `switch` preserve the current macro frame.
Synthetic callers are the sole callable bodies whose invocation parent retains
their explicitly confined call-site scope.

Block-set and filter-block captures reject nested macro declarations during
complete parsing. Nunjucks's generated JavaScript has inconsistent failures for
these placements, so the secure subset does not create capture-specific export
or closure semantics.

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
callable identities into a macro scope. Evaluation first resolves the static
call-block target and requires its sealed value to be a macro. Only then are
ordinary arguments evaluated and the caller body registered, so an invalid
target cannot trigger argument or body capabilities.

Filters and tests similarly resolve their operation names before evaluating
input and argument expressions. A dotted filter spelling is stored as one
parser-created symbol and resolved directly against the private registry; it
never becomes a member lookup. `select` and `reject` validate their named test
once before inspecting the input sequence, including when that sequence is
empty or an unsupported scalar. Known operations retain source-order operand
evaluation.

A synchronous filter block lowers to `Output(Filter(Capture(body), ...args))`.
Resolution and registered-filter keyword validation happen before `Capture`.
Once valid, the body is captured with normal statement semantics before the
explicit arguments are evaluated, and the standard filter path performs the
dispatch. Captured output and final filtered output are both charged to the
render limits.

Each non-macro callable has an explicit argument policy. Registered filters and
globals accept only positional syntax. Stateful built-in constructors and
methods validate their maximum or exact arity, while built-in tests validate
exact positional arity and reject keywords before evaluating them. After
accepted expressions are evaluated, one recursive validator rejects callable
identities at any nesting depth before capability charging, built-in storage,
transformation, or dispatch. Macros and callers remain the only general route
for forwarding caller authority; `callable` and closed identity tests are the
only standard operations that may intentionally inspect it.

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
closed values passed into a filter plus fixed-size slots projected for indexed
array-like record materialization; it is not a general allocation or heap
limit. Indexed positions, including missing sparse positions, are charged as
work and reserved before iteration or allocation. Output growth uses JavaScript
string length as a cheap memory-pressure guard and is intentionally UTF-16
code-unit rather than exact byte accounting.
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
