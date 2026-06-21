# Runtime and interpreter

## Execution model

Nunjitsu executes a synchronous native TypeScript interpreter in the caller
process. Security comes from interpreting a closed grammar over copied values.
The runtime never uses `eval`, `Function`, `vm`, generated JavaScript, dynamic
imports, or a JavaScript parser to execute expressions.

## Complete data-only AST

Each inline source is fully parsed before execution. Template and expression
nodes are closed discriminated unions containing only primitives, child nodes,
and arrays of nodes. They cannot contain callbacks, descriptors, host values,
or executable closures.

Full parsing reports syntax errors in inactive branches and unused macros.
Template-loading and extension nodes are rejected. No AST or source survives a
render.

## Closed values

The interpreter owns all values:

- undefined, null, booleans, numbers, and strings;
- arrays of engine values;
- records backed by private string-keyed maps;
- regular-expression literals represented as inert pattern/flag data; and
- sealed callable variants created by the interpreter.

Input arrays and records are recursively copied. Records are never used as
JavaScript prototypes or accessed through `object[key]` inside the interpreter.
`constructor`, `prototype`, and `__proto__` are reserved throughout parsing,
copying, scopes, lookup, assignment, registries, and callback results.

## Scopes and calls

Lexical scopes are engine-owned frames with private maps and explicit parent
links. Calls dispatch only to inline macros, interpreter built-ins, or exact
registered global-function identities. Context functions, methods,
constructors, and looked-up values are never callable.

## Output

Evaluation collects string chunks in a render-owned buffer and returns their
joined value. Automatic escaping is disabled to match Backstage. Explicit
Nunjucks filters such as `escape` still provide their documented behavior.
Rendered output remains attacker-controlled and is not a general HTML, SQL, or
shell sanitizer.

## Cooperative limits

High finite limits account for source characters, AST nodes, evaluator work,
nesting, allocation, output, and capability calls. These are cooperative
availability safeguards, not a process sandbox or exact CPU/RSS accounting.
Trusted callbacks execute outside interpreter work accounting except for their
invocation count and returned-value validation.
