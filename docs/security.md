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
- loaders;
- custom filters, tests, globals, and tag renderers; and
- Nunjitsu and its production dependencies.

The lockfile-pinned Nunjucks 3.2.4 parser is therefore part of the trusted
computing base. Its mutable parser objects never cross into evaluation: an
exhaustive converter copies only allowlisted primitive and child-node fields
into frozen data-only nodes, rejecting every other value.

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
engine-owned values before evaluation. The public input model accepts:

- `undefined`, `null`, booleans, finite or JavaScript-compatible numbers, and
  strings;
- explicitly marked safe strings;
- arrays containing accepted values; and
- plain records whose enumerable own properties are data descriptors containing
  accepted values.

Functions, accessors, symbols, class instances, typed arrays, dates, maps,
sets, weak collections, promises, errors, and other exotic objects are
rejected. Cycles and excessive depth are rejected. Repeated non-cyclic aliases
may retain identity through internal graph references.

The names `constructor`, `prototype`, and `__proto__` are rejected at every
ingress and syntax location and always fail closed during lookup. Prototype
pollution of `Object.prototype` cannot affect interpreter lookup because host
objects are never used as scopes or template records.

## Capabilities

Capabilities are the only route to trusted application behavior. Engine-level
loaders, filters, tests, globals, and declarative tags receive immutable
identities during synchronous engine creation.

The interpreter stores capability identities, never callback functions. A call
copies internal arguments to a null-prototype public value graph, invokes the
exact registered callback through the host dispatcher, and copies its result
back through the safe value validator. Capability results are not implicitly
safe.

A capability is authority. Applications must expose narrow behavior and assume
an untrusted template can invoke every registered capability with arbitrary
valid arguments up to configured limits.

## Loaders

There is no default current-working-directory loader. Built-in filesystem
loading is constrained to explicit canonical roots and rejects traversal,
symlink escape, and invalid names. A template can request names but cannot use
Node filesystem APIs directly.

Loaders are trusted. Their returned source is untrusted template text and is
fully parsed before execution.

## Resource limits

High finite defaults cover parsing, evaluator work, nesting, allocation,
output, loaders, and capabilities. They reduce accidental and intentional
denial of service but are cooperative checks rather than hard isolation.

Regular-expression literals preserve JavaScript-compatible behavior. A hostile
pattern can cause excessive backtracking between interpreter checkpoints;
applications requiring strict availability isolation must execute rendering in
their own worker, process, or container and impose external deadlines.

## Output boundary

Autoescaping and safe-string semantics are compatibility features, not a
general output sanitizer. An untrusted template can author literal markup and
may use Nunjucks-compatible raw/safe operations. Callers must treat rendered
content as attacker-controlled and apply the policy required by its destination.
