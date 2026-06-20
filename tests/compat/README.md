# Nunjucks compatibility corpus

This directory adapts behavioral cases from
[`mozilla/nunjucks` v3.2.4](https://github.com/mozilla/nunjucks/tree/v3.2.4/tests),
commit `86a77f49da4779d55414d8337e1a4d7ec7582da5`. Nunjucks and its copied or
adapted test material are copyright James Long and contributors and licensed
under the adjacent [BSD-2-Clause license](upstream/LICENSE).

`upstream-inventory.json` records every upstream Mocha `it(...)` case without
making the upstream repository a network dependency. `manifest.json` maps
classified upstream assertions to language-neutral cases in `cases.json`.
Coverage is intentionally explicit: the manifest remains incomplete until
every inventory entry is classified as ported, adapted, or not applicable.
Release validation must reject incomplete coverage.

While coverage is partial, an entry may itself use `status: "partial"` with a
reason and removal condition when only some assertions from one upstream Mocha
case have been adapted. Partial entries are forbidden once the document moves
to complete coverage.

Case context uses ordinary JSON plus `{ "$nunjitsu": "safe", "value": "..." }`
for explicitly safe strings. Additional tagged values must be added to the
schema rather than encoded as executable JavaScript.

Cases that require trusted host behavior name a deterministic
`capabilityFixture` and set `nativeRender` to `false`; the TypeScript harness
provides the fixture while still exercising the Rust/Wasm evaluator. Omitting
`autoescape` verifies the engine default, while an explicit boolean fixes the
mode for all other cases.
