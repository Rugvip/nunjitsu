# Security

## Security objective

Fully untrusted template source must have no template-language path to execute
JavaScript, access ambient Node.js authority, inspect live host objects, or
invoke behavior that was not explicitly registered for templates.

This is a property of the closed parser, value model, and interpreter. It is
not a claim that Nunjitsu, Node.js, or V8 can contain their own implementation
or memory-safety vulnerabilities.

Trusted code outside the guarantee includes:

- application code constructing context containers;
- engine configuration;
- custom filters and globals; and
- Nunjitsu and its production dependencies.

The host realm's standard ECMAScript constructors and intrinsic methods are
also trusted. Replacing globals such as `RegExp` or `JSON.stringify`, or
replacing standard prototype methods, is outside the application-level sandbox
contract and requires process or realm isolation. The value boundary still
prevents template data from supplying those hooks and avoids inherited
`Object.prototype` iteration and serialization hooks on the containers it
inspects or materializes.

The production parser and standard library are native project code with no
runtime dependencies. The single-pass scanner and closed expression parser can
construct only the supported frozen data-only node variants. No foreign parser
objects or host filter implementation crosses into evaluation. Nunjucks remains
a development-only compatibility oracle and benchmark baseline outside the
production trust boundary.

Complete-source validation includes unused macro and call-block declarations,
the full contents of structural stop tags, matching named block closers, and raw
or verbatim opening tags before raw scanning begins. Invalid formal expressions
or trailing structural content therefore fail before evaluator construction;
earlier output, declaration defaults, wrapper macros, raw contents, and later
capabilities cannot execute.

Both `elif` and `elseif` are expression-bearing conditional continuations.
Missing or malformed continuation expressions and trailing content after
`else` or `endif` fail complete-source parsing before any branch capability can
run; `else if` is not accepted as an alias.

Parser-owned whitespace classification prevents unsupported Unicode spacing
characters from disguising code boundaries. Code accepts only space, tab, LF,
CR, and NBSP; broader ECMAScript whitespace is recognized only by template-data
trim controls and `lstripBlocks`. Raw and verbatim scanning requires balanced
same-name depth before evaluation, so a missing outer closer fails complete
source validation before any capability can run. Inner markers use their own
full-whitespace, no-hyphen grammar, and terminal LF or CRLF closers fail safely
before evaluation rather than reproducing the pinned tokenizer exception.

It also rejects direct `Neg(Neg(...))` and `Pos(Pos(...))` expression shapes in
every syntax position, including inactive branches and unused macro defaults.
This preserves Nunjucks's compiler-derived syntax rejection without generating
JavaScript and prevents repeated signs from reaching capability evaluation.

Strings, numbers, booleans, nulls, arrays, and record data supplied through
trusted application code may contain hostile data. Node's native proxy brand
check rejects proxy-backed values, including nested and revoked proxies, before
the copier performs array detection, prototype lookup, key enumeration, or
descriptor inspection. Rejection therefore does not execute proxy traps.

## Prohibited execution paths

Interpreter and parser modules must not use:

- `eval`, `Function`, async/generator constructors, or indirect equivalents;
- `node:vm` or generated JavaScript;
- dynamic import or module resolution from template-controlled data;
- reflective property or prototype traversal on host values;
- implicit object coercion, iteration protocols, getters, or methods; or
- JavaScript functions stored in template-visible values.

Template identifiers resolve only through engine-owned map-backed scopes.
Attribute access dispatches only over closed internal value kinds. Calls
dispatch only over sealed interpreter callable variants.

## Safe value boundary

Context and capability results are recursively copied into immutable
engine-owned values before evaluation. The public context model accepts:

- `null`, booleans, JavaScript numbers, and strings;
- arrays containing accepted values; and
- plain records whose enumerable own properties are data descriptors containing
  accepted values.

Capability arguments use the same public shapes. A capability may additionally
return `undefined`, which becomes the interpreter's absent value. Safe strings
are created only inside the interpreter by approved built-ins and macro
captures; callers cannot inject a safe-string wrapper through public data.
Their closed boolean conversion is always true, including for empty wrapped
text, while explicit length and iteration remain based on the text itself.

Functions, accessors, symbols, class instances, typed arrays, dates, maps,
sets, weak collections, promises, errors, and other exotic objects are
rejected. Proxies and cycles are rejected recursively. Repeated non-cyclic
aliases may retain identity through internal graph references. Accepted arrays
are copied by inspecting own indexed data descriptors; the copier never
consumes an inherited iteration protocol. Missing descriptors remain private
sparse holes rather than being converted into present `undefined` elements.
The interpreter stores presence independently, keeps its dense backing indices
as own data properties, and never exposes a template-visible sentinel.

Capability argument arrays preserve holes as absent frozen indices. Present
closed `undefined` elements retain their existing conversion to present public
`null` values, so host callbacks can distinguish index presence without
receiving interpreter state or live caller arrays. Capability results cross the
same descriptor-copy boundary.

Prepared contexts retain this copied graph across renders without retaining the
host objects it came from. They are opaque, bound to one engine, and immutable.
Explicit path updates pass the replacement through the same copier and derive a
new snapshot; template execution cannot commit assignments into a snapshot.
This prevents later host mutation, iteration overlays, and redacted views from
changing one another.

The names `constructor`, `prototype`, and `__proto__` are rejected at input,
syntax, scope, internal record construction, lookup, assignment, registry, and
capability boundaries. This invariant is enforced again when records cross to
capability arguments, so a built-in cannot synthesize a reserved property that
reaches host code. Prototype pollution of `Object.prototype` cannot affect
interpreter lookup because host objects are never used as scopes or template
records.

Record enumeration is also interpreter-owned and deterministic. Numeric index
keys follow JavaScript property order before named keys across literals, copied
contexts, derived records, and prepared updates. Capability invocation order
from record loops therefore cannot diverge merely because the closed record is
map-backed, and no host object conversion is used to obtain that ordering.

## Semantic role changes

Template-controlled data is revalidated whenever its role changes:

- dictionary syntax and record-producing built-ins pass every derived key
  through `RuntimeRecord`, which cannot represent a reserved key;
- filter attributes are prepared according to their direct-key or getter-path
  policy; exact direct keys and every nested path segment reject reserved names,
  while permitted direct keys may contain dots without becoming traversal;
- attribute traversal uses presence-aware closed own lookup over records,
  arrays, and strings, and a non-empty lookup on null or undefined fails before
  later template evaluation rather than becoming an absent value;
- record membership uses the closed record's presence operation, keeping an
  allowed key containing `undefined` distinct from a missing or reserved key;
- safe-string membership recognizes only the engine-owned `length` and `val`
  fields after closed property-key conversion; it neither searches wrapped
  content nor reflects inherited String or Object prototype properties;
- equality dispatches explicitly by closed value kind; strict comparisons use
  identity and loose comparisons never invoke object coercion hooks;
- switch selection uses closed strict identity, and callable identity comparison
  never invokes the registered host callback;
- lookup, membership, derived keys, arithmetic, concatenation, and relational
  operations use centralized closed coercion rather than output rendering;
  callable coercion fails closed recursively before rendering, capture,
  serialization, standard-library transformation, or separator construction;
- built-in type failures stop evaluation, while unsupported scalar results
  remain absent instead of becoming generic zero or empty-string values that
  could select a different policy branch;
- `center` and `truncate` read only interpreter-owned direct lengths before
  deciding whether text operations are needed, and `wordcount` checks closed
  falsiness first; callable identities are still rejected recursively before
  any unchanged array or record can pass through;
- regex replacement validates closed primitive-string or safe-string input before
  numeric or generic string conversion, returns only an ordinary string, and
  stops evaluation before later capabilities for every other input kind;
- `range`, `sum`, and `joiner` retain closed value types and use closed
  comparison or addition at the same observable points as pinned Nunjucks, so
  eager numeric or string conversion cannot change strict branches or switch
  selection;
- truthy-attribute `join` and `sum` reproduce Nunjucks's map-before-method
  ordering through closed own lookup, including scalar-empty and array-like
  inputs, without invoking host properties, iteration, or methods;
- empty cyclers advance from their initial `null` state to closed `undefined`
  on `next()` and return to `null` only on reset, preventing stale state from
  selecting a capability branch that Nunjucks would skip;
- numeric filter arguments retain their closed values through default
  selection and use filter-specific repeat, substring, replacement, URL,
  exponent, and JSON-spacing semantics, preventing eager normalization from
  selecting a different capability-bearing branch;
- strict `dictsort`, `round`, and `dump` options inspect original closed types
  rather than coercing safe strings or other values into dispatch tokens;
- ordinary built-in filter keywords become an interpreter-owned final
  positional record with a forced `__keywords` marker, while only `int` and
  `sort` use closed `makeMacro` normalization so occupied positional slots
  override same-named keywords; all original values remain subject to
  recursive callable rejection and scratch accounting before ignored or
  surplus arguments are discarded and dispatch begins;
- Jinja subscript slices use only closed length, ordering, addition, key
  conversion, and own lookup; each selected value is callable-checked before
  entering the result and each attempted result is work- and scratch-charged;
- numeric ordering compares closed converted values directly rather than by
  subtraction, so equal infinities cannot fail open into a different branch
  while `NaN` remains unordered;
- assignment, macro, direct filter, and global names originate from validated
  parser symbols and resolve through private maps; direct tests statically
  select a closed name and optional argument node through an exhaustive AST
  switch, map all composite shapes without a direct name or value to the
  built-in `undefined` test, and never evaluate those ignored shapes; dynamic
  test names accepted by `select` and `reject` are checked against the closed
  registry before iteration, while attribute selectors perform only direct
  truthiness and safely discard surplus values;
- macro calls bind only declared formal names at their fixed positions and the
  explicit call-block `caller` keyword; unmatched keywords cannot introduce
  locals or callable identities;
- duplicate macro and caller formals use closed Nunjucks argument normalization:
  missing ordinary formals consume keywords, surplus positionals replace
  default-name entries, and every duplicate binds sequentially, so default
  capability calls and the final callable selection cannot be skipped;
- macro declaration visibility is assigned by a static numeric-slot pass before
  evaluation; inactive and duplicate declarations retain compiler-selected
  `undefined` slots instead of falling through to a registered capability,
  while runtime value frames and shared exports remain separate;
- positional macro and caller parameters, loop targets, and reassigned macro
  slots retain direct-slot identity independently of their current value kind;
  defaulted caller formals cannot hide an inherited call-site slot, and loop
  metadata cannot overwrite or discard a direct callable value;
- repeated loop entry reuses only compiler-owned direct and control storage for
  the enclosing function invocation; multi-target array branches expose no
  target-name runtime locals, while record/string branches replace only the
  first two direct and runtime bindings and preserve extra array temporaries.
  Branch-specific assignments, duplicates, safe-string classification, and
  later `else` bodies therefore cannot expose or discard callable authority
  differently from Nunjucks;
- standalone blocks carry no inheritance chain and synthesize no `super`
  authority; call blocks target only macros, and their `caller` handle cannot
  cross or be silently discarded at capability or built-in boundaries;
- call-block targets are side-effect-free static references, and macro, filter,
  and test validity is established before any associated argument, operand,
  caller body, or selection element can execute;
- filter blocks use the same sealed filter dispatcher as pipe expressions;
  unknown filters and invalid registered-filter keywords fail before body
  capture or argument evaluation, while valid bodies remain subject to normal
  callable rejection, output limits, and fail-stop capability handling;
- every non-macro call recursively rejects callable identities from positional
  and keyword values before capability charging, built-in storage, dispatch,
  transformation, or discard; unsupported keyword and surplus-argument syntax
  is rejected before its expressions execute;
- parenthesized groups reject callable identities recursively from every
  non-final child before discarding it, while preserving a final sealed callable
  for ordinary explicit dispatch; empty groups fail during complete parsing;
- sealed internal callable identities cannot cross the public value boundary;
  and
- capability arguments and results are recursively recopied rather than
  retaining either side's objects or prototypes.

Other names that resemble inherited JavaScript properties, including
`toString`, `valueOf`, `hasOwnProperty`, and accessor helper names, remain valid
ordinary data. They are safe inside map-backed records and null-prototype
public records, but capability implementations must still treat their names and
values as untrusted input.

## Capabilities

Capabilities are the only route to trusted application behavior. Engine-level
filters and globals receive immutable identities during synchronous engine
creation.

The interpreter stores capability identities, never callback functions. A call
first resolves its target through lexical scope and closed-value lookup. Only a
resolved capability callable can reach the host dispatcher, and its opaque ID
maps privately to the exact registered callback independent of call-site
spelling. Context data, local bindings, computed strings, and object paths
cannot manufacture or redirect that identity. Filter names may contain multiple
dot-separated valid identifier segments, but the complete spelling is one
private capability ID rather than a lookup path; every segment rejects reserved
names. Global registry names remain single valid template identifiers, and
dotted global names are rejected. The call copies internal arguments to a public
value graph whose records have null prototypes and copies its result back
through the safe value validator. Capability results are not implicitly safe.
Callback execution and result validation share one protected failure boundary,
so a proxy or other invalid result becomes an opaque capability failure rather
than exposing the rejected value or a trap-thrown object.

Direct resolution of one registered global reuses a canonical render-local
sealed handle. Ordinary member lookup creates a fresh sealed alias with the
same private kind and ID so identity changes without changing authority. The
alias contains no callback, receiver, prototype, binding object, or host
reference, and dispatch still consults the evaluator's private ID map. Neither
canonical handles nor aliases can cross capability arguments or results, be
forged by public template data, or survive the evaluator that owns them.

Built-ins that temporarily materialize internal data as JavaScript containers
must also prevent inherited host hooks from becoming observable. In particular,
`dump` serializes only null-prototype records and arrays, so an inherited
`toJSON` accessor or function cannot run during template evaluation. It rejects
callable identities at any nesting depth rather than converting them to JSON
`null` or omission. Inert regex values become fresh empty null-prototype records
for serialization only, matching RegExp's empty enumerable JSON shape without
creating a native RegExp, exposing pattern data, or consulting either internal
or native regex prototypes.

Sparse-array consumers select dense numeric or present-entry traversal
explicitly. This prevents holes from becoming values that satisfy membership,
selection, or policy checks while retaining Nunjucks behavior for loops, edge
lookup, batching, reversal, sorting, slicing, and URL encoding. Own indices on
transient arrays are defined through data descriptors so inherited numeric
setters cannot observe construction.

When another operation or a capability argument requires regex text, one
engine-owned helper creates the inert canonical Nunjucks spelling. It escapes
line terminators, normalizes an empty pattern to `(?:)`, and emits flags in
`gimy` order without consulting `RuntimeRegex.prototype`,
`RegExp.prototype.toString`, or another host conversion hook. Approved matching
continues to use the separately retained validated pattern and flags.

The built-in `random` filter uses Node's synchronous cryptographic integer
selection. Template-controlled calls therefore neither observe nor advance the
host application's shared `Math.random` state.

A capability is authority. Applications must expose narrow behavior and assume
an untrusted template can invoke every registered capability with arbitrary
valid arguments up to configured limits.

Registered filters and globals expose a positional-only public API. Keyword
syntax is rejected before any keyword value expression executes. Their input
and positional values are recursively checked for sealed callable identities
independently of scratch accounting, so disabling that resource estimate cannot
weaken the authority boundary. Stateful built-ins apply the same recursive
check before retaining values, and their methods reject ignored arguments
before evaluating them. Built-in tests define exact arity; only `callable` and
closed identity comparisons may inspect callable values.

Capability exceptions are fail-stop. The host boundary preserves diagnostic
text only from a primitive string or a native error with an own string-valued
`message` data descriptor. Native-error branding rejects proxies without
invoking traps, and descriptor inspection never reads an accessor. The detail
passes through the central control-character neutralizer and length bound.
Every other thrown value produces a fixed message.

The boundary constructs a new engine-owned error containing only that inert
string and discards the original thrown value. No original error, proxy, or
exotic object remains reachable through the public error, so later
logging, recursive inspection, or serialization cannot execute its getters,
proxy traps, coercion methods, `toJSON`, or custom inspection hooks. The
exception immediately unwinds the interpreter, no later template node or
capability executes, no partial output is returned, and the thrown value never
becomes template-visible. Sanitized diagnostic text may still contain secrets
or internal details and must not be returned automatically to untrusted clients.

Public API validation completes before entering the template-evaluation error
boundary. Invalid source, context, prepared-context ownership, and render-limit
configuration therefore retain their direct `TypeError` or `RangeError`
contracts. Once evaluation starts, every failure except `NunjitsuLimitError`
is wrapped in `NunjitsuRenderError`; an attacker-controlled template cannot
select a built-in JavaScript error class to bypass application render-error
handling. The wrapper retains no underlying cause. It exposes only a bounded
engine-owned message, stable parse/evaluation phase and failure code, and the
deepest available one-based template coordinates. Unknown internal thrown
values are never retained; non-native values receive a fixed diagnostic, while
native engine errors contribute only an own string-valued message data property.

Parser diagnostics never interpolate raw token content. Source-derived values
use a central quoted formatter that escapes C0, C1, terminal, line-separator,
and every Unicode `Bidi_Control` character—including U+061C, U+200E, and
U+200F—and truncates long values. The public render boundary independently
neutralizes controls and bounds the complete message, so logging
`NunjitsuRenderError.message` cannot create additional log lines, terminal
control sequences, or bidirectional visual spoofing. Logging or recursively
inspecting the complete error is also safe because `cause` is always
`undefined` and no raw internal stack or error object crosses the boundary.

Regular-expression grammar is parser-owned rather than inherited from the host
Node.js version. Literals accept only `g`, `i`, `m`, and `y`; unsupported or
duplicate flags and ambiguous even-backslash delimiter runs fail complete-source
validation with fixed diagnostics before any capability executes. Native
`RegExp` receives only the accepted inert pattern and flags for validation and
approved built-in matching.

Nunjitsu accepts inline source only and imports no filesystem APIs. Applications
perform file discovery, path confinement, symbolic-link handling, and reads
before source crosses into the renderer.

## Resource limits

High finite defaults cover source size, AST nodes, evaluator work, interpreter
nesting, rendered output, filter-argument scratch size, and trusted capability
calls. They reduce accidental and intentional denial of service but are
cooperative checks rather than hard isolation or general heap limits.

Indexed filters over array-like records, including truthy-attribute `join` and
`sum`, project their numeric work and fixed-size result slots before visiting
or allocating positions. Sparse missing entries count toward both projections,
preventing a tiny record with a hostile `length` from amplifying into an
unbounded intermediate array before a limit check. The projection remains an
estimate rather than exact V8 heap accounting.

Jinja slice syntax cannot always project its result count because string and
fractional addition may change index type as it advances. It therefore charges
one work unit and one indexed scratch slot per attempted result. Steps with
zero or non-finite numeric coercion are rejected before iteration; remaining
non-progressing additions terminate through the cooperative work limit.

Output growth is bounded by UTF-16 code units, matching the returned JavaScript
string and providing a cheap approximate memory guard. It is not exact V8 heap
or encoded-output accounting.

Interpreter nesting is checked at every statement and expression evaluation
checkpoint. This bounds recursive evaluator frames; it does not replace source
size and parser-side AST-node limits.

Regular-expression literals use native JavaScript matching only after the
parser has restricted flags to the fixed Nunjucks v3.2.4 `gimy` set and
validated the pattern. A hostile pattern can still cause excessive backtracking
between interpreter checkpoints; applications requiring strict availability
isolation must execute rendering in their own worker, process, or container and
impose external deadlines.

Native RegExp operations also update legacy host-realm fields such as
`RegExp.$1`, `input`, and `lastMatch`. Every registered filter and global
invocation resets all capture and context fields immediately before argument
copying and callback entry. Its `finally` block resets them again only after
callback execution, result copying and validation, or exception-message
extraction and sanitization has completed. Capabilities therefore cannot
observe match state from template parsing, built-ins, or earlier capabilities,
and state created by a capability cannot survive its boundary.

Every public render exit executes the same private nine-capture reset in
`finally` as defense in depth after successful evaluation, parsing or
evaluation failure, resource failure, and API validation failure. Existing
legacy state is intentionally cleared because JavaScript exposes no reliable
way to restore it.

This cleanup prevents template-controlled matches from crossing a capability
boundary or surviving the render; it does not move native regex execution to
another realm, prevent backtracking, or make the legacy fields suitable
application state. Trusted capabilities must not rely on ambient RegExp
properties persisting across their invocation boundary.

## Output boundary

Autoescaping and safe-string semantics are compatibility features, not a
general output sanitizer. An untrusted template can author literal markup and
may use Nunjucks-compatible raw/safe operations. Callers must treat rendered
content as attacker-controlled and apply the policy required by its destination.
