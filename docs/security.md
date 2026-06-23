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

Functions, accessors, symbols, class instances, typed arrays, dates, maps,
sets, weak collections, promises, errors, and other exotic objects are
rejected. Proxies and cycles are rejected recursively. Repeated non-cyclic
aliases may retain identity through internal graph references. Accepted arrays
are copied by inspecting own indexed data descriptors; the copier never
consumes an inherited iteration protocol.

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

## Semantic role changes

Template-controlled data is revalidated whenever its role changes:

- dictionary syntax and record-producing built-ins pass every derived key
  through `RuntimeRecord`, which cannot represent a reserved key;
- attribute strings are split into explicit path segments, reject reserved
  segments, and traverse only `RuntimeRecord` entries;
- record membership uses the closed record's presence operation, keeping an
  allowed key containing `undefined` distinct from a missing or reserved key;
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
- `range`, `sum`, and `joiner` retain closed value types and use closed
  comparison or addition at the same observable points as pinned Nunjucks, so
  eager numeric or string conversion cannot change strict branches or switch
  selection;
- numeric filter arguments retain their closed values through default
  selection and use filter-specific repeat, substring, replacement, URL,
  exponent, and JSON-spacing semantics, preventing eager normalization from
  selecting a different capability-bearing branch;
- assignment, macro, direct filter, direct test, and global names originate
  from validated parser symbols and resolve through private maps; dynamic test
  names accepted by selection filters are checked against the closed registry
  before iteration;
- macro calls bind only declared formal names at their fixed positions and the
  explicit call-block `caller` keyword; unmatched keywords cannot introduce
  locals or callable identities;
- standalone blocks carry no inheritance chain and synthesize no `super`
  authority; call blocks target only macros, and their `caller` handle cannot
  cross or be silently discarded at capability or built-in boundaries;
- call-block targets are side-effect-free static references, and macro, filter,
  and test validity is established before any associated argument, operand,
  caller body, or selection element can execute;
- every non-macro call recursively rejects callable identities from positional
  and keyword values before capability charging, built-in storage, dispatch,
  transformation, or discard; unsupported keyword and surplus-argument syntax
  is rejected before its expressions execute;
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
cannot manufacture or redirect that identity. Global registry names must be
single valid template identifiers; dotted names are rejected rather than
treated as implicit namespaces. The call copies internal arguments to a public
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
`null` or omission.

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

Nunjitsu accepts inline source only and imports no filesystem APIs. Applications
perform file discovery, path confinement, symbolic-link handling, and reads
before source crosses into the renderer.

## Resource limits

High finite defaults cover source size, AST nodes, evaluator work, interpreter
nesting, rendered output, filter-argument scratch size, and trusted capability
calls. They reduce accidental and intentional denial of service but are
cooperative checks rather than hard isolation or general heap limits.

Output growth is bounded by UTF-16 code units, matching the returned JavaScript
string and providing a cheap approximate memory guard. It is not exact V8 heap
or encoded-output accounting.

Interpreter nesting is checked at every statement and expression evaluation
checkpoint. This bounds recursive evaluator frames; it does not replace source
size and parser-side AST-node limits.

Regular-expression literals preserve JavaScript-compatible behavior. A hostile
pattern can cause excessive backtracking between interpreter checkpoints;
applications requiring strict availability isolation must execute rendering in
their own worker, process, or container and impose external deadlines.

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
