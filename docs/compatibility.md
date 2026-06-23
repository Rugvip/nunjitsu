# Direct string templating compatibility

## Baseline

The compatibility target is a simpler, secure direct-string subset of
[`mozilla/nunjucks` v3.2.4](https://github.com/mozilla/nunjucks/tree/v3.2.4).
The API processes complete inline strings rather than exposing the full
Nunjucks environment or template-loading API.

Nunjucks is retained only as a development dependency for output-equivalent
benchmarks and compatibility verification. Production source does not import
or package it: template scanning, expression parsing, filters, and tests are
implemented by the closed native TypeScript runtime.

Nunjitsu targets:

- `${{ ... }}` interpolation, `{% ... %}` statements, and `{# ... #}` comments;
- Cookiecutter `{{ ... }}` mode and its `jsonify` alias;
- expressions, truthiness, scoping, loops, inline macros, call blocks, and
  rendering semantics used within one source;
- lexical and context shadowing when resolving callable globals;
- presence-based macro defaults that preserve explicit null, undefined, and
  falsey arguments;
- Nunjucks-compatible UTF-16 code-unit semantics for string length, lookup,
  iteration, ordering, filters, replacement, and Jinja-compatible slicing;
- explicit Nunjucks-compatible strict and loose equality over closed values;
- Nunjucks-compatible closed primitive, property-key, numeric, concatenation,
  lookup, membership, and relational coercion without host object hooks;
- observable Nunjucks mixed-operator grouping, including left-associative
  exponentiation, concatenation in the emitted additive tier, and wrapped
  floor-division behavior among multiplicative operators;
- observable comparison, membership, test, and prefix-`not` grouping, including
  Nunjucks's generated-code behavior where it differs from conventional unary
  precedence;
- Nunjucks parser acceptance for parenthesized nested inline conditionals and
  string or ordinary-identifier dictionary keys;
- target-count-sensitive Nunjucks loop behavior for arrays, primitive and safe
  strings, and array-like or key-value records, including raw loop-length
  metadata, else selection, and flat symbol-only binding targets;
- render-local canonical identity for direct callable globals, fresh sealed
  identity for ordinary callable member lookup, and strict identity-based
  switch matching;
- declaration-specific macro and caller validation, Nunjucks positional/default
  ordering, positional call arguments after keywords, and complete structural
  tag validation including named blocks and raw regions;
- built-in filters, tests, and globals used by direct string templates;
- pinned built-in input domains, nullish normalization, keyword arguments, and
  fail-before-later-capability behavior over the closed value model;
- type-preserving `range`, `sum`, and `joiner` behavior, including JavaScript-
  style ordered comparison and addition without eager normalization;
- synchronous application filters and `TemplateValue` data or callable globals;
- `trimBlocks` and `lstripBlocks`; and
- fixed `autoescape: false` behavior.

## Outside the contract

Nunjitsu does not support:

- named templates, includes, imports, inheritance, or loaders;
- inheritance-defined `super`; standalone `super()` is unresolved unless the
  application explicitly registers an ordinary capability with that name;
- the Nunjucks JavaScript API, object model, CLI, or Express integration;
- precompilation, persistent caches, browser execution, or streaming;
- asynchronous filters, globals, or rendering;
- host-defined tests or custom parser extensions;
- arbitrary delimiters or public lexer/parser APIs;
- exact upstream exception classes, messages, or source formatting; or
- arbitrary JavaScript objects, prototypes, getters, or methods in template
  data.

Unsupported syntax is rejected explicitly. Security deviations are part of the
contract, not hidden compatibility failures.

Call blocks accept only direct or static constant-key macro references. They
reject effectful target expressions during parsing and reject non-macro targets
before evaluating call arguments or registering the caller body. Unknown
filters and tests are likewise rejected before their operands and arguments,
and selection filters validate a named test even for empty inputs. These
fail-closed ordering rules intentionally take precedence over Nunjucks behavior
where its generated JavaScript would evaluate otherwise-unused expressions.

Safe strings are internal text values rather than emulations of Nunjucks's
prototype-bearing JavaScript `String` wrapper. Collection filters therefore
treat them consistently as primitive UTF-16 text instead of reproducing wrapper
indexing gaps that can yield `undefined`. Callable identities are also rejected
where Nunjucks might stringify, serialize, or silently discard a JavaScript
function; this preserves the closed capability boundary.

## Upstream test corpus

The attributed Nunjucks v3.2.4 test inventory remains the source for applicable
language behavior. The parity manifest classifies every upstream case against
the narrower secure direct-string contract. Applicable behavior is adapted
into data-only cases under `tests/compat/`; loader, browser, JavaScript API,
extension, and other out-of-scope cases are marked not applicable with a
reason.

## Attribution and licensing

Nunjucks is licensed under the
[`BSD-2-Clause` license](https://github.com/mozilla/nunjucks/blob/v3.2.4/LICENSE).
Copied or adapted test materials retain that license and Mozilla Nunjucks
attribution adjacent to the corpus. Original Nunjitsu code is licensed under
the MIT License.
