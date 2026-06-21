# Architecture

## Purpose

Nunjitsu is a native TypeScript renderer for a simpler Nunjucks subset,
optimized for secure direct string templating. It replaces generated-JavaScript
template execution with a closed interpreter.

The design prioritizes, in order:

1. preventing untrusted template source from gaining JavaScript execution or
   ambient access to the Node.js process;
2. compatibility with direct string templates and expressions;
3. a small, auditable synchronous API; and
4. low retained memory for one-shot rendering.

Security takes precedence over compatibility and performance when those goals
conflict.

## System boundaries

```mermaid
flowchart LR
    A["Application caller"] --> B["TypeScript engine"]
    B --> C["Safe value copier"]
    B --> D["Tokenizer and parser"]
    D --> E["Immutable data-only AST"]
    C --> F["Closed synchronous interpreter"]
    E --> F
    F <--> G["Trusted filters and globals"]
    F --> H["Rendered string"]
```

### Engine

`createEngine` synchronously constructs an immutable registry of filters and
globals. `render` accepts one inline source string and returns one string.
`prepareContext` optionally copies reusable caller data into an opaque
engine-bound snapshot; immutable path updates derive new snapshots with
structural sharing. Nunjitsu has no loaders, filesystem access, streams,
workers, Wasm modules, or resources requiring disposal.

Applications supply strings directly and perform any file discovery, path
policy, and reads before invoking the renderer. Path traversal, symbolic links,
archive extraction, and filesystem races are therefore outside the template
execution boundary.

### Parser

The native parser makes a single-pass scan over each complete template,
tokenizes expressions, and uses a closed precedence parser for the supported
grammar. It does not invoke Nunjucks, a JavaScript-language parser, generated
JavaScript, or host behavior. It constructs frozen discriminated-union object
nodes with stable direct properties and child references. There is no generic
foreign-node conversion boundary or packed numeric arena.

Default variables use `${{` and `}}` delimiters. Cookiecutter mode
uses `{{` and `}}` with the supported Jinja compatibility behavior. Block and
comment delimiters remain `{% ... %}` and `{# ... #}`.

The complete inline source is parsed before execution. The parser charges the
AST-node resource limit as it creates each node, rejects template-loading tags
(`include`, `import`, `from`, and `extends`) and extensions, and freezes every
node and child collection. The AST is owned by one render and discarded when
that render ends.

### Interpreter

The interpreter evaluates the AST directly over engine-owned values and
map-backed scopes. Identifiers, attributes, indices, operators, coercions,
comparisons, and calls are explicit operations over closed value variants.
They never delegate to JavaScript property lookup or implicit object coercion.

The only callable values are sealed interpreter variants for inline macros,
built-ins, and registered global functions. A template value cannot contain a
JavaScript function or constructor.

## Render lifecycle

1. The caller supplies inline source and either a JSON-compatible context or an
   explicitly retained prepared snapshot.
2. Plain context input is copied and validated into the closed value graph;
   prepared input reuses its already validated graph.
3. The complete source is parsed into a data-only AST.
4. The synchronous interpreter evaluates the AST with cooperative limits.
5. Trusted filter and global calls receive copied JSON-compatible values, and
   their results cross the same validator.
6. The final string is returned.
7. The AST, scopes, one-shot values, and output state become unreachable.
   Prepared context values remain reachable only through caller-held snapshots.

## Architectural non-goals

- Complete Nunjucks template or JavaScript API parity.
- Includes, imports, inheritance, or any template loader.
- Browser support.
- Streaming or asynchronous filters, globals, or rendering.
- A JavaScript or `vm`-based template sandbox.
- Live proxying of arbitrary JavaScript object graphs into templates.
- Calling context functions or object methods.
- Host-defined tests or custom parser tags.
- A precompiler or persistent compiled-template cache.
- Arbitrary delimiter configuration.
- Sanitizing template-authored output for a downstream sink.
