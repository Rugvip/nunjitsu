# Nunjucks compatibility

Nunjitsu targets a secure direct-string subset of
[`mozilla/nunjucks` v3.2.4](https://github.com/mozilla/nunjucks/tree/v3.2.4).
Use the [Nunjucks templating documentation](https://mozilla.github.io/nunjucks/templating.html)
as the general syntax guide and this page to check which parts apply to
Nunjitsu.

Nunjucks is a development-only compatibility oracle and benchmark baseline.
The published package contains its own TypeScript parser, interpreter, filters,
tests, and globals and does not import Nunjucks at runtime.

## Supported model

Nunjitsu renders one complete source string synchronously. The default variable
delimiters are `${{` and `}}`; block tags use `{%` and `%}`, and comments use
`{#` and `#}`.

`cookiecutterCompat: true` switches variable interpolation to `{{` and `}}` and
enables the supported Jinja/Cookiecutter adaptations, including `jsonify`.

The supported language includes:

- literals, arrays, records, lookups, arithmetic, comparisons, membership,
  boolean expressions, inline conditionals, regular-expression literals, and
  Jinja-style slices;
- `if`/`elif`/`elseif`/`else`, `for`/`else`, `switch`, assignments, standalone
  blocks, raw/verbatim regions, and whitespace controls;
- inline macros, defaults, keyword calls, call blocks, and synchronous filter
  blocks;
- the built-in filters, tests, and globals covered by the compatibility corpus;
- application-defined synchronous filters and globals; and
- `trimBlocks` and `lstripBlocks`.

Within this subset, Nunjitsu follows the observable rendering behavior of
pinned Nunjucks, including its occasionally surprising operator grouping,
coercion, scoping, sparse-array, UTF-16 string, macro, loop, and built-in-filter
semantics. The compatibility tests use rendered Nunjucks output as the oracle
rather than assuming conventional JavaScript or Jinja behavior.

## Intentional differences

Security rules take precedence when Nunjucks behavior would expose or discard
JavaScript authority. In particular:

- context values are copied plain data rather than live JavaScript objects;
- object methods and context functions are not callable;
- filters and globals are fixed when the engine is created and are synchronous;
- callable identities cannot be converted, stored in ordinary data, passed to
  capabilities, or silently discarded by unsupported arguments;
- malformed or unsupported complete source fails before any template code runs;
- resource limits are enabled by default; and
- errors are engine-owned diagnostics rather than upstream Nunjucks exceptions.

These differences are part of the public contract, not compatibility gaps.

## Outside the contract

Nunjitsu does not support:

- named templates, loaders, includes, imports, inheritance, or inherited
  `super`;
- the Nunjucks JavaScript API, environment object model, CLI, or Express
  integration;
- precompilation, persistent compiled-template caches, browser execution,
  streaming, or asynchronous rendering;
- host-defined tests, custom parser extensions, or arbitrary delimiters;
- exact Nunjucks error classes, messages, source formatting, or live-object
  behavior; or
- automatic output escaping.

Unsupported template-loading and extension syntax is rejected explicitly.
Applications that need those features should continue using Nunjucks or perform
the surrounding work before passing an inline source string to Nunjitsu.

## Compatibility corpus

`tests/compat/manifest.json` classifies every test in the pinned Nunjucks v3.2.4
inventory as ported, adapted, or outside the direct-string contract. Applicable
rendering behavior is stored as data-only cases in `tests/compat/cases.json`;
cases requiring capabilities or boundary assertions link to source tests through
`tests/compat/coverage.json`.

The suite runs language-neutral cases through both engines so expected output
cannot drift independently. Parser and security adaptations are tested directly
against the Nunjitsu public API.

## Attribution and licensing

Nunjucks is licensed under the
[`BSD-2-Clause` license](https://github.com/mozilla/nunjucks/blob/v3.2.4/LICENSE).
Copied or adapted test materials retain that license and Mozilla Nunjucks
attribution adjacent to the corpus. Original Nunjitsu code is licensed under
the [MIT License](../LICENSE).
