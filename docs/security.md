# Security

## Security objective

Nunjitsu must be able to execute fully untrusted template source without giving
that template ambient access to the Node.js process. Worker isolation alone is
not the security model. The model combines a constrained value boundary,
explicit capabilities, rooted loading, and deterministic resource accounting.

The following host code remains trusted and is outside the sandbox guarantee:

- loaders;
- custom filters, tests, globals, and extension renderers;
- application code that creates engines or render-local capabilities; and
- the Nunjitsu TypeScript and Rust implementation itself.

A trusted callback can perform unsafe actions or return sensitive data.
Nunjitsu cannot make an arbitrary callback safe.

## Safe value boundary

Template context is copied into the render arena. Templates never receive a
live JavaScript object proxy.

Repeated references to the same non-cyclic array or record are copied once per
render and retain alias identity inside the arena. This supports strict
`sameas` behavior without retaining or exposing the original host object.

The portable value model consists of:

- `undefined` and `null`;
- booleans and JavaScript-number-compatible numeric values;
- UTF-8 strings and explicitly marked safe strings;
- arrays;
- plain own-key records; and
- explicit opaque capability handles.

Getters, prototype chains, methods, arbitrary functions, exotic host objects,
and cyclic graphs are rejected unless behavior is deliberately represented by
a registered capability. Property access operates only on the copied safe
representation. Security takes precedence where this differs from Nunjucks
behavior on arbitrary live JavaScript objects.

Encoders must bound nesting, element counts, key sizes, string sizes, and total
bytes while copying input. A rejected input must not leave a partially usable
render in the worker.

## Capabilities

Capabilities are the only way a template can request host behavior. Engine-level
loaders, filters, tests, globals, and extension schemas receive numeric IDs when
the engine is created. That registry is immutable for the engine lifetime.

Render-local capability handles may be allocated in a separate render-local
namespace, but they must not mutate the engine registry or survive cleanup.
Every request identifies the capability, operation, arguments, render, and
continuation. Responses are accepted only for the matching pending request.

Custom tags use declarative grammar schemas parsed by Rust. Schemas may describe
arguments and template bodies but cannot execute arbitrary parser code or
manipulate internal syntax records. Rendering a custom tag may yield to its
trusted host capability.

## Loaders

There is no default current-working-directory loader. Callers must provide
inline source or explicitly configure a loader. The package may provide:

- an in-memory loader; and
- a filesystem loader constrained to explicit roots.

Loaders return a canonical identity with the source. The engine uses that
identity for per-render deduplication, include stacks, and cycle detection. A
filesystem loader must normalize and validate paths, reject traversal and root
escape, and treat symlink behavior explicitly. Merely checking a string prefix
is insufficient.

Relative names beginning with `./` or `../` are resolved from the requesting
frame's canonical identity. Canonical identity must follow the source through
deferred blocks and macros. Request caches must include both parent identity and
requested name; keying only by the relative spelling can substitute a template
from another directory. The final resolved filesystem path must remain within
an explicitly configured canonical root even when the parent path or target
contains symlinks.

Loaders are trusted authority. A template can request names but cannot bypass
the loader or access Node filesystem APIs directly.

## Resource limits

Limits are configured per render. There is no immutable engine-wide ceiling,
and callers may explicitly loosen a limit or choose an effectively unlimited
value. Omitting limits uses a finite safe default profile.

The profile must account for at least:

- evaluator work units;
- parser, expression, call, include, and inheritance nesting;
- arena bytes and collection sizes;
- output bytes;
- loader and capability calls; and
- outstanding asynchronous work.

An `AbortSignal` or deadline complements deterministic accounting but does not
replace it. Exceeding a limit, cancellation, a callback failure, or a malformed
ABI response must all terminate the render and run full cleanup.

Nunjucks-compatible regular-expression replacement executes synchronously in
the isolated render worker through a range-validated numeric Wasm import. This
preserves JavaScript `RegExp` flags, captures, and replacement syntax without
granting templates a host capability. Because backtracking cost is not
predictable from input size, callers accepting untrusted regex literals must
provide an `AbortSignal` with an application deadline; cancellation terminates
and recycles the affected worker.

Choosing unlimited limits is an explicit opt-out from denial-of-service
protection. The API documentation must state that clearly.

## Output and escaping

Nunjucks-compatible autoescaping and safe-string semantics are correctness and
security requirements. Capability results are not implicitly safe. Marking a
value safe must require an explicit typed operation.

Streaming output is not atomic. Consumers must assume that a stream can expose
partial escaped output before a later error and decide whether their destination
can tolerate partial writes.
