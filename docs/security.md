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
- lookup, membership, derived keys, arithmetic, concatenation, and relational
  operations use centralized closed coercion rather than output rendering;
  callable coercion fails closed;
- assignment, macro, filter, test, and global names originate from validated
  parser symbols and resolve through private maps;
- macro calls bind only declared formal names at their fixed positions and the
  explicit call-block `caller` keyword; unmatched keywords cannot introduce
  locals or callable identities;
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

Built-ins that temporarily materialize internal data as JavaScript containers
must also prevent inherited host hooks from becoming observable. In particular,
`dump` serializes only null-prototype records and arrays, so an inherited
`toJSON` accessor or function cannot run during template evaluation.

The built-in `random` filter uses Node's synchronous cryptographic integer
selection. Template-controlled calls therefore neither observe nor advance the
host application's shared `Math.random` state.

A capability is authority. Applications must expose narrow behavior and assume
an untrusted template can invoke every registered capability with arbitrary
valid arguments up to configured limits.

Capability exceptions are fail-stop. The host boundary preserves diagnostic
text only from a primitive string or a native error with an own string-valued
`message` data descriptor. Native-error branding rejects proxies without
invoking traps, and descriptor inspection never reads an accessor. The detail
passes through the central control-character neutralizer and length bound.
Every other thrown value produces a fixed message.

The boundary constructs a new engine-owned error containing only that inert
string and discards the original thrown value. No original error, proxy, or
exotic object remains reachable through the public cause chain, so later
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
handling.

Parser diagnostics never interpolate raw token content. Source-derived values
use a central quoted formatter that escapes C0, C1, terminal, line-separator,
and bidirectional formatting controls and truncates long values. The public
render boundary independently neutralizes controls and bounds the complete
message, so logging `NunjitsuRenderError.message` cannot create additional log
lines or terminal control sequences.

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
`RegExp.$1`, `input`, and `lastMatch`. Every public render exit executes a
private nine-capture reset in `finally`, overwriting all capture and context
fields with deterministic empty values after successful evaluation, parsing or
evaluation failure, resource failure, and API validation failure. Existing
legacy state is intentionally cleared because JavaScript exposes no reliable
way to restore it.

This cleanup prevents template-controlled matches from surviving the render;
it does not move native regex execution to another realm, prevent backtracking,
or make the legacy fields suitable application state. Trusted capabilities run
inside the synchronous render and must not rely on ambient RegExp properties.

## Output boundary

Autoescaping and safe-string semantics are compatibility features, not a
general output sanitizer. An untrusted template can author literal markup and
may use Nunjucks-compatible raw/safe operations. Callers must treat rendered
content as attacker-controlled and apply the policy required by its destination.
