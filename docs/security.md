# Security

Nunjitsu is designed to render fully untrusted template source without giving
that source implicit access to JavaScript or the surrounding Node.js process.
It does this with a closed interpreter and an explicit capability model.

This page describes the security contract applications can rely on. Exact
implementation invariants and regression details live in
[`CONTEXT.md`](../CONTEXT.md).

## Threat model

Assume an attacker controls the complete template source and every value passed
through an untrusted context. The attacker may deliberately trigger unusual
syntax, coercion, recursion, large outputs, errors, and capability calls.

The renderer is responsible for preventing that input from:

- executing generated or dynamically constructed JavaScript;
- reaching host globals, prototypes, constructors, getters, methods, or module
  loading;
- turning template data into a callable application capability;
- passing internal runtime objects or callable handles to application code; or
- escaping through exception objects or diagnostic formatting.

## What the boundary guarantees

Templates execute only through parser and interpreter operations implemented by
Nunjitsu. The runtime does not use `eval`, `Function`, `node:vm`, generated
JavaScript, or template-controlled dynamic imports.

Every context and capability result is recursively copied into renderer-owned
values. Scopes and records are private and map-backed, and all lookup,
coercion, comparison, iteration, and call behavior is implemented by closed
value kind. The names `constructor`, `prototype`, and `__proto__` are reserved
throughout the language and data boundary.

Only sealed identities created for macros, built-ins, and registered filters or
globals are callable. Strings, context functions, object paths, and computed
property names cannot manufacture a callable identity.

## Accepted data

The public value model accepts:

- `null`, booleans, numbers, and strings;
- arrays containing accepted values; and
- plain records containing accepted values in enumerable own data properties.

The copier rejects functions, symbols, accessors, proxies, custom prototypes,
class instances, typed arrays, dates, maps, sets, promises, errors, cycles, and
other behavior-bearing values. It inspects property descriptors rather than
reading getters and does not consume inherited iteration protocols.

Prepared contexts contain the same copied values. They never observe later
mutation of the caller's objects, and failed path updates do not modify the
original snapshot.

## Capabilities

Filters and global functions are trusted application code. Registering one
grants every template rendered by that renderer permission to invoke it with
attacker-controlled arguments.

Keep capabilities narrow:

- validate arguments for the application operation they perform;
- avoid generic object merging, property access, command execution, or query
  construction;
- return only supported plain data;
- do not return secrets that the template should not render; and
- treat a capability error message as potentially sensitive application data.

Arguments are frozen public copies with no runtime prototypes or callable
handles. Results cross the same safe-value copier before evaluation continues.
If a callback throws or returns an invalid value, rendering stops immediately.

Capability callbacks run in the caller process and are outside evaluator work
accounting. They must be synchronous, bounded, and safe for the application to
execute.

## Resource limits

Every render starts with cooperative limits:

| Limit | Default | Covers |
| --- | ---: | --- |
| `sourceCodeUnits` | `4_194_304` | UTF-16 source length |
| `astNodes` | `1_000_000` | Parsed AST nodes |
| `workUnits` | `1_000_000` | Static planning, evaluation, and value expansion |
| `nestingDepth` | `512` | Nested statement and expression evaluation |
| `outputCodeUnits` | `16_777_216` | UTF-16 output length |
| `scratchBytes` | `67_108_864` | Estimated data supplied to one filter |
| `capabilityCalls` | `4_096` | Registered filter and global calls |

Applications can override individual values through `TemplateRenderOptions.limits`.
Each override must be a non-negative safe integer or `Infinity`.

These checks are availability safeguards, not a hard memory limit, exact CPU
budget, or process sandbox. Use process isolation when the deployment requires
strong resource containment or protection from bugs in trusted capabilities.

## Failures and diagnostics

API validation errors are reported before template evaluation. Parser and
runtime failures use `TemplateRenderError`; exhausted resource limits use
`TemplateLimitError`. Rendering is fail-stop and never returns partial output.

Public render errors contain renderer-owned, bounded, single-line diagnostics
and safe template coordinates when available. They do not retain the internal
exception or a capability-thrown object as `cause`. Applications should still
avoid returning diagnostics directly to untrusted clients because a trusted
capability may include sensitive information in its own error message.

## Regular-expression state

JavaScript regular-expression operations can modify deprecated process-global
fields such as `RegExp.$1`. Nunjitsu clears that legacy state before and after
every capability and again when a render exits. Rendering may therefore clear
legacy RegExp state that application code set earlier; it cannot restore that
state reliably. Applications and capabilities must not rely on those deprecated
fields.

The `random` filter uses Node.js cryptographic integer selection and does not
read or advance the application's `Math.random` stream.

## Output is still untrusted

The interpreter prevents templates from gaining JavaScript authority; it does
not make their rendered text safe for a destination. Automatic escaping is
disabled. Applications must apply the correct sink-specific handling for HTML,
URLs, SQL, shells, configuration files, and other consumers.

## Outside the guarantee

Nunjitsu does not provide hard process isolation, exact CPU or heap accounting,
safe behavior for application capabilities, protection from regular-expression
backtracking in approved patterns, secret-data zeroization, or sanitization of
rendered output. The security contract also assumes trusted standard Node.js
intrinsics and an uncompromised Nunjitsu installation.
