# Nunjucks compatibility

## Baseline

The compatibility baseline is the immutable
[`mozilla/nunjucks` v3.2.4 release](https://github.com/mozilla/nunjucks/tree/v3.2.4).
Upstream `master` is not a moving CI dependency. Adopting another release is an
explicit, reviewed change to this document and the test corpus provenance.

Nunjitsu targets observable template and runtime behavior:

- template syntax and whitespace behavior;
- expressions, truthiness, scoping, and rendering semantics;
- built-in filters, tests, and globals;
- includes, imports, macros, inheritance, and blocks;
- synchronous and asynchronous template behavior; and
- the ability to add host filters, tests, globals, loaders, and custom tags
  through the new capability model.

Existing Nunjucks templates within this contract should render without edits.

## Explicitly outside the contract

Compatibility does not include:

- Nunjucks's JavaScript API, object model, CLI, Express integration, or loader
  registration API;
- precompilation or a persistent compiled-template format;
- browser execution;
- exact upstream exception classes, messages, formatting, or source locations;
- arbitrary JavaScript object/prototype/getter behavior inside template data;
  or
- Nunjucks parser-node APIs for arbitrary custom extension parsers.

Invalid upstream cases must fail when the failure is semantically required, but
matching exact diagnostic text or type is not a compatibility gate. Nunjitsu
may provide better structured diagnostics under its own API without claiming
those details are upstream-compatible.

Sandbox constraints are intentional deviations. Safe copied values replace
live JavaScript objects, and custom tags use declarative grammars. These
deviations must be visible in the parity manifest rather than hidden as skipped
tests.

## Upstream test corpus

The upstream [`tests/`](https://github.com/mozilla/nunjucks/tree/v3.2.4/tests)
suite is the source of truth. Nunjitsu will adapt its underlying cases into one
language-neutral corpus under `tests/compat/`. Rust tests and TypeScript public
API tests consume the same case definitions.

The corpus contains:

- template source and fixture files;
- tagged safe input values;
- expected output or expected failure;
- named loader and capability fixtures when behavior cannot be represented as
  data alone; and
- provenance back to the upstream file and case.

A parity manifest classifies every upstream test as:

- **ported**: represented directly by a shared case;
- **adapted**: equivalent behavior tested through Nunjitsu's API or security
  model; or
- **not applicable**: outside the documented contract, with a specific reason.

No upstream case may remain unclassified. Expected failures require an owner,
reason, and removal condition; an unexplained skip is not a valid state.

During implementation, the checked-in manifest may declare partial coverage so
the remaining gap is measurable rather than hidden. Partial coverage is never
a release-ready state. The immutable inventory still records every upstream
case from the start, and completion requires a one-to-one classification audit
against that inventory.

See [Testing](testing.md) for execution and release gates.

## Attribution and licensing

Nunjucks is licensed under the
[`BSD-2-Clause` license](https://github.com/mozilla/nunjucks/blob/v3.2.4/LICENSE).
Copied or adapted test materials must retain that license and clear Mozilla
Nunjucks attribution adjacent to the corpus. The corpus must record the v3.2.4
source tag and upstream paths.

The repository's Apache-2.0 license applies to original Nunjitsu code. It does
not replace the upstream license on copied test material. Do not copy upstream
tests until their license file, attribution, provenance format, and parity
manifest are added in the same change.
