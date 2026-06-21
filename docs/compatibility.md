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
- built-in filters, tests, and globals used by direct string templates;
- synchronous application filters and JSON-valued or callable globals;
- `trimBlocks` and `lstripBlocks`; and
- fixed `autoescape: false` behavior.

## Outside the contract

Nunjitsu does not support:

- named templates, includes, imports, inheritance, or loaders;
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
attribution adjacent to the corpus. Original Nunjitsu code remains Apache-2.0.
