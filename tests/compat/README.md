# Nunjucks compatibility corpus

This directory adapts behavioral cases from
[`mozilla/nunjucks` v3.2.4](https://github.com/mozilla/nunjucks/tree/v3.2.4/tests),
commit `86a77f49da4779d55414d8337e1a4d7ec7582da5`. Nunjucks and its copied or
adapted test material are copyright James Long and contributors and licensed
under the adjacent [BSD-2-Clause license](upstream/LICENSE).

`upstream-inventory.json` records every upstream Mocha `it(...)` case without
making the upstream repository a network dependency. `manifest.json` maps
classified upstream assertions to language-neutral cases in `cases.json`.
Coverage is intentionally explicit: the checked-in manifest classifies every
inventory entry against the Backstage scaffolder renderer contract as ported,
adapted, or not applicable. Release validation rejects incomplete coverage.

Entries may use `status: "partial"` with a reason and removal condition only
during future compatibility work. Partial entries are forbidden in the
complete manifest.

Case context uses ordinary JSON. Cases that require trusted host behavior name
a deterministic filter/global fixture; the TypeScript harness provides it while
exercising the closed native interpreter.
