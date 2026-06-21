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

The production parser and standard library are native project code with no
runtime dependencies. The single-pass scanner and closed expression parser can
construct only the supported frozen data-only node variants. No foreign parser
objects or host filter implementation crosses into evaluation. Nunjucks remains
a development-only compatibility oracle and benchmark baseline outside the
production trust boundary.

Strings, numbers, booleans, nulls, arrays, and record data supplied through
trusted application code may contain hostile data. Hostile JavaScript proxies
are outside the boundary because JavaScript provides no trap-free way to
inspect them.

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
rejected. Cycles are rejected. Repeated non-cyclic aliases may retain identity
through internal graph references.

Prepared contexts retain this copied graph across renders without retaining the
host objects it came from. They are opaque, bound to one engine, and immutable.
Explicit path updates pass the replacement through the same copier and derive a
new snapshot; template execution cannot commit assignments into a snapshot.
This prevents later host mutation, iteration overlays, and redacted views from
changing one another.

The names `constructor`, `prototype`, and `__proto__` are rejected at every
ingress and syntax location and always fail closed during lookup. Prototype
pollution of `Object.prototype` cannot affect interpreter lookup because host
objects are never used as scopes or template records.

## Capabilities

Capabilities are the only route to trusted application behavior. Engine-level
filters and globals receive immutable identities during synchronous engine
creation.

The interpreter stores capability identities, never callback functions. A call
copies internal arguments to a null-prototype public value graph, invokes the
exact registered callback through the host dispatcher, and copies its result
back through the safe value validator. Capability results are not implicitly
safe.

A capability is authority. Applications must expose narrow behavior and assume
an untrusted template can invoke every registered capability with arbitrary
valid arguments up to configured limits.

Capability exceptions are fail-stop. The host boundary catches a thrown value
only to place it opaquely behind an engine-owned error with a fixed message; it
does not read properties from that value. The exception immediately unwinds
the interpreter, no later template node or capability executes, no partial
output is returned, and the thrown value never becomes template-visible.

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

## Output boundary

Autoescaping and safe-string semantics are compatibility features, not a
general output sanitizer. An untrusted template can author literal markup and
may use Nunjucks-compatible raw/safe operations. Callers must treat rendered
content as attacker-controlled and apply the policy required by its destination.
