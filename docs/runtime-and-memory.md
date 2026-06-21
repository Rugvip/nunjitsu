# Runtime and interpreter

## Execution model

Nunjitsu executes a native TypeScript interpreter directly in the caller
process. The interpreter is asynchronous so template loading and explicitly
registered capabilities can await trusted application work. Workers and child
processes are optional application-level availability measures, not part of the
template-language security boundary.

Security comes from interpreting a closed grammar over copied values. The
runtime must never use `eval`, `Function`, `vm`, generated JavaScript, dynamic
imports, or a JavaScript parser to execute template expressions.

## Complete data-only AST

Each source is tokenized and fully parsed before execution. Template and
expression nodes are closed discriminated unions with source spans. Nodes may
contain only primitives, child nodes, and arrays of nodes. They must not contain
callbacks, property descriptors, host values, or executable closures.

Full parsing ensures syntax errors are reported even in inactive branches and
unused macros. Loaded dependencies are parsed on demand, cached only within the
current render by canonical identity, and released with the render. There is no
cross-render AST or dependency cache by default.

## Closed values

The interpreter uses an engine-owned value graph:

- undefined and null;
- booleans and JavaScript-compatible numbers;
- strings and explicitly trusted safe strings;
- arrays of engine values;
- records backed by private string-keyed maps;
- regular-expression literals represented as inert pattern/flag data; and
- sealed callable variants created only by the interpreter.

Input arrays and records are recursively copied before evaluation. Records are
never used as JavaScript prototypes or accessed through `object[key]` inside
the interpreter. Property and index access dispatches on the internal value
kind and uses explicit map or array operations.

`constructor`, `prototype`, and `__proto__` are reserved throughout parsing,
input copying, scopes, record literals, lookup, assignment, registries, and
capability results. They are never representable as template-visible names.

## Scopes and calls

Lexical scopes are engine-owned frames with private maps and explicit parent
links. Lookup traverses only those maps. Missing values follow documented
Nunjucks semantics; lookup never falls through to a JavaScript prototype or
global object.

Calls dispatch exhaustively over sealed callable variants:

- macros and callers;
- interpreter-owned built-ins such as range, cycler, and joiner; and
- immutable numeric identities for registered host capabilities.

All other call attempts fail. In particular, context functions, methods,
constructors, and values obtained through property lookup are never callable.

## Loading and deferred templates

Includes, imports, and inheritance resolve through explicit trusted loaders.
Every loaded source has a canonical identity. Relative dependencies resolve
from the identity of the source containing the directive, including through
macros, blocks, `super`, and custom-tag bodies.

The render-local request cache is keyed by canonical parent plus requested name;
loaded ASTs are deduplicated by resolved canonical identity. No source, AST, or
dependency graph survives the render.

Loaders return source text and identities only. Nunjitsu does not include a
filesystem loader; applications own filesystem access and confinement before
source crosses into the engine.

## Output

The evaluator writes string chunks to a render-owned sink. Buffered rendering
collects chunks and joins them at completion. Streaming rendering exposes the
same chunks through a pull-driven `ReadableStream<string>` and may report an
error after earlier chunks were observed.

Coercion and escaping operate only on internal value variants. They never call
user-defined `toString`, `valueOf`, iteration protocols, getters, or methods.
Safe strings require an explicit trusted marker or Nunjucks-compatible template
operation. The core guarantee prevents host-process escape; it does not make
arbitrary template-authored output safe for HTML, SQL, shell, or another sink.

## Cooperative limits

Limits are high but finite by default. They account for at least:

- total source characters loaded and AST nodes created;
- evaluator steps;
- expression, call, include, inheritance, and collection nesting;
- collection and string growth;
- output characters;
- loader and capability calls; and
- outstanding asynchronous work.

Limits and `AbortSignal` checks are cooperative availability safeguards, not a
JavaScript sandbox or strict CPU/RSS accounting. Callers may explicitly loosen
them. Trusted callbacks execute outside interpreter accounting except for their
invocation count and returned-value validation.
