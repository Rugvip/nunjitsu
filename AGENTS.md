# Project instructions

These instructions apply to the entire repository. They exist to keep
implementation and documentation aligned with the architecture in
[`docs/`](docs/index.md).

## Before changing code

1. Read [`README.md`](README.md), [`docs/index.md`](docs/index.md), and the
   documentation page for the area being changed.
2. Check whether the change conflicts with a settled constraint below. Do not
   work around an architectural decision silently.
3. If a cross-cutting decision must change, update the relevant documentation
   and this file in the same change, including the reason and consequences.

## Project-wide architectural constraints

- Target Node.js 22 or newer. Browser support is out of scope, and Node APIs
  may be used throughout the package outside the closed interpreter boundary.
- Keep the TypeScript package at the repository root and manage it with the
  `packageManager`-pinned pnpm version and `pnpm-lock.yaml`. Do not add another
  package-manager lockfile. Author one erasable `.ts` source tree and compile it
  into tested ESM and CommonJS builds with generated declarations using the
  lockfile-pinned TypeScript 7.0 RC.
- Construct engines synchronously and render synchronously. Engine-level
  filters and globals are immutable after creation.
- Implement template execution as a closed native TypeScript interpreter in
  the caller process. Do not add Rust, Wasm, a worker protocol, or generated
  JavaScript execution back into the runtime.
- Parse each complete source into an immutable, data-only AST before executing
  it. AST nodes must not contain functions, host objects, property descriptors,
  or executable closures.
- Represent AST variants as frozen plain object nodes with stable direct typed
  properties and direct child references. Do not add generic field bags,
  packed numeric arenas, or ArrayBuffer storage without a measured end-to-end
  benefit that justifies the additional evaluator complexity.
- Do not use `eval`, `Function`, constructor-derived equivalents, `node:vm`,
  generated JavaScript, dynamic import, or a JavaScript parser to execute
  template syntax.
- Copy context and capability results into the closed engine-owned value graph.
  Never retain live host objects, prototypes, getters, functions, methods, or
  iteration protocols in template-visible values.
- Store scopes and records in private maps and implement every lookup,
  coercion, comparison, and call explicitly by internal value kind. Never use
  reflective host property access as an evaluator shortcut.
- Reserve `constructor`, `prototype`, and `__proto__` across input, syntax,
  scopes, registries, internal record construction, lookup, assignment, and
  capability arguments and results.
- Make sealed interpreter variants for macros, built-ins, and registered
  capabilities the only callable values. Context functions and object methods
  are unsupported.
- Resolve every call target through lexical scope and the closed value model.
  Dispatch capabilities only through evaluator-owned IDs mapped privately to
  exact registered callbacks; never derive authority from call-site spelling.
- Validate filter registry names as one or more dot-separated ordinary
  identifier segments, rejecting reserved segments everywhere. Parse a dotted
  filter spelling into one exact sealed capability ID, never a lookup path.
  Keep global registry names restricted to one identifier.
- Lower synchronous filter blocks through the ordinary `Output`, `Filter`, and
  `Capture` AST variants. Resolve the exact filter and reject registered-filter
  keyword syntax before evaluating the body; otherwise capture the body before
  evaluating explicit filter arguments. `endfilter` accepts no trailing content.
- Recursively reject callable identities from every positional and keyword
  value before non-macro dispatch, storage, transformation, or discard.
  Registered filters and globals are positional-only; reject keyword syntax
  before evaluating its values. Validate built-in and test arity before
  evaluating unsupported arguments. Only macro/caller forwarding, the
  `callable` test, and closed identity tests may intentionally carry callables.
- Represent call blocks with their own AST variant. Accept only a direct symbol
  or static constant-key lookup as the target, resolve and require a macro
  before evaluating arguments, and register the caller body only afterwards.
  Resolve filter and test existence before evaluating their operands or
  arguments, including tests named through `select` and `reject`.
- Do not represent inheritance-only block chains or synthesize a `super`
  callable. Standalone blocks have one body and isolated scope; an explicitly
  registered global named `super` remains an ordinary capability. Call blocks
  may target only template macros, and their internal `caller` handle must not
  be forwarded to or discarded by capabilities or built-ins.
- Bind macro arguments by fixed formal position first and matching keyword
  presence second, never value nullishness or a conditional positional cursor.
  Ignore undeclared keywords except for the explicit call-block `caller`
  binding. Evaluate defaults only for genuinely absent arguments.
- Track macro name binding separately from value lookup. Root, standalone block,
  nested block, and ordinary macro bodies export declarations to the template
  macro frame; `if` and `switch` inherit it. Loop and synthetic caller bodies
  keep declarations local. Ordinary macros use the template scope as their
  invocation parent and never capture loop, caller, or outer-macro locals;
  synthetic callers alone retain their confined call-site value scope.
- Reject macro declarations anywhere inside block-set or filter-block captures
  during complete parsing rather than inventing capture-specific macro scope.
- Validate macro and caller declarations separately from ordinary calls. Every
  positional formal must be a symbol; default keys must be parser-created
  allowed names. Store ordinary formals before defaulted formals, allow source
  positionals after defaults or call keywords, and retain the first binding for
  duplicate formal names while preserving applicable default evaluation.
- Never retain template sources, ASTs, values, or output state between renders
  by default. Retain values only through an explicit caller-owned prepared
  context snapshot; keep snapshots immutable and engine-bound, and copy every
  update through the safe value boundary.
- Treat template source as fully untrusted. Copy context into the safe value
  model; do not expose prototypes, getters, arbitrary functions, or live host
  objects. Host behavior requires explicit capability handles.
- Apply high finite cooperative resource limits by default on every render.
  Account for source size, AST nodes, evaluator work, depth, output,
  filter-argument scratch size, and capability calls. Do not describe these
  checks as general heap limits, process isolation, or exact CPU/RSS accounting.
- Accept inline template source only. Filesystem discovery and path policy
  belong to the application outside Nunjitsu. Reject include, import, from, and
  extends because the secure direct-string API does not support template loading.
- Target the documented secure direct-string subset of Nunjucks v3.2.4, not its
  complete JavaScript or template-loading API. Precompilation, browser
  execution, streaming, async callbacks, exact upstream error text, live-object
  semantics, custom tests, and parser extensions are outside the contract.
- Use `${{` and `}}` as the default variable delimiters. Cookiecutter mode uses
  `{{` and `}}` with the supported Jinja compatibility behavior. Do not expose
  arbitrary delimiter configuration or the Nunjucks lexer/parser object model.
- Maintain one attributed parity manifest and language-neutral compatibility
  corpus, with explicit supplemental coverage mappings for parser, interpreter,
  and public API behavior. Classify every upstream v3.2.4 test in the manifest.
- Publish only through `.github/workflows/publish.yml` using npm trusted
  publishing bound to the `npm` GitHub environment. Ongoing releases must be
  staged from an exact stable-version GitHub Release tag, never published with
  a repository npm token.

The rationale and detailed contracts live in:

- [`docs/architecture.md`](docs/architecture.md)
- [`docs/runtime-and-memory.md`](docs/runtime-and-memory.md)
- [`docs/security.md`](docs/security.md)
- [`docs/compatibility.md`](docs/compatibility.md)
- [`docs/testing.md`](docs/testing.md)
- [`docs/releasing.md`](docs/releasing.md)

## Repository structure

- `src/`: TypeScript public API, parser, interpreter, filters, and globals.
- `src/parser/`: tokenizer and closed template/expression parser.
- `src/runtime/`: safe values, scopes, interpreter, output, and limits.
- `benchmarks/`: synchronous inline parsing and expression comparisons with
  the pinned Nunjucks baseline.
- `tests/compat/`: shared Nunjucks v3.2.4 cases, provenance, manifest, and
  upstream license.
- `docs/`: normative architecture documentation.
- Generated JavaScript, declarations, coverage, and fuzz artifacts belong
  in ignored build directories, never beside authored source.

Do not create additional packages without a documented architectural reason.

## TypeScript rules

- Keep source compatible with Node's built-in type stripping. Enable and obey
  `erasableSyntaxOnly`, `verbatimModuleSyntax`, strict checking, and relative
  import extension rewriting.
- Do not use runtime enums, parameter properties, runtime namespaces, import
  aliases, decorators requiring transformation, or path aliases that Node
  cannot execute directly.
- Use explicit `type` imports and source file extensions that work when Node
  executes `.ts` directly.
- Add TSDoc to every declared type and every exported API. Document ownership,
  lifetime, units, failure behavior, and security implications where relevant.
- Build ESM and CommonJS from the same TypeScript entrypoint. Do not add
  format-specific source implementations, entry adapters, or runtime behavior.
- Use braced control flow unless the surrounding file has an established
  different style. Avoid `any` at safe-value and capability boundaries.

## Interpreter security rules

- Keep tokenizer, parser, AST types, values, scopes, evaluator, capabilities,
  output, and limits in responsibility-focused modules.
- Use exhaustive discriminated-union handling for AST nodes, values, and
  callable variants. An unknown variant is an internal error, never a fallback
  to JavaScript behavior.
- Validate the complete template before executing any node from that source.
- Validate the complete contents of structural tags. `else`, `endif`, `endfor`,
  `endmacro`, `endcall`, `endset`, `default`, and `endswitch` accept no trailing
  content; `endblock` accepts only an optional matching opening name; and raw or
  verbatim openers accept no arguments before scanner raw-mode entry.
- Require every switch to contain at least one `case` or `default` arm after
  comments are discarded. Preserve empty arm bodies and empty-case fallthrough,
  but reject an arm-free switch during complete parsing.
- Treat `elif` and `elseif` as equivalent conditional continuation tags with a
  required expression. Keep `else if` invalid because `else` accepts no trailing
  content, and validate every continuation before evaluation.
- Keep parser whitespace domains explicit. Code tokens accept only space, tab,
  LF, CR, and NBSP; unsupported ECMAScript whitespace in code is rejected.
  Explicit `-` controls and `lstripBlocks` use the full ECMAScript whitespace
  set. Do not use general `trim`, `trimStart`, or `\s` for code parsing.
- Scan raw and verbatim regions with same-name nesting depth. Preserve nested
  markers and mixed raw/verbatim markers as literal text, require the outer
  same-name closer, preserve content after a top-level opening `-%}`, and reject
  hyphenated closing markers. Inside a raw region, recognize markers with the
  full template-data whitespace set and no left or right hyphen; safely reject
  a terminal closer containing LF or CRLF while allowing multiline non-terminal
  nested markers.
- Inspect input records through own property descriptors and reject accessors.
  Do not invoke getters while copying accepted plain records.
- Reject Node-detected proxies before array detection or any reflective value
  inspection. Keep capability result copying inside the opaque fail-stop
  exception boundary.
- Keep parser and evaluator internals private. Do not pass AST nodes, scopes,
  internal values, or callable variants to host callbacks.
- Revalidate template-controlled data whenever it changes semantic role, such
  as a value becoming a key, path segment, binding, or callable identity.
  Enforce the invariant in the owning representation as well as at external
  boundaries.
- Use presence-aware map and record operations when semantics depend on whether
  a key exists. Never infer presence from a retrieved value because
  interpreter-owned records may store `undefined`.
- Make every `RuntimeRecord` enumerate canonical JavaScript array-index keys
  from `0` through `4294967294` in ascending numeric order, followed by other
  string keys in first-insertion order. Replacing a key changes only its value.
  Apply this invariant in construction and derived updates rather than relying
  on host-object enumeration or consumer-specific sorting.
- Model strings consistently as UTF-16 code units for length, indexing,
  iteration, filters, slicing, and work accounting. Iterate primitive strings
  by numeric index rather than their host iteration protocol.
- Implement Jinja subscript slices as direct closed lookup loops. Preserve raw
  fractional and string start, stop, and step values, adjust negative bounds
  once without clamping, include the `length` index when an explicit stop
  reaches beyond it, and increment through closed addition. Reject steps whose
  numeric coercion is zero or non-finite, charge every attempted result, bound
  scratch growth, and reject selected callable identities before storage.
- Treat every safe-string wrapper as truthy, including one containing empty
  text. Keep that wrapper truthiness separate from content-based text length,
  indexing, iteration, and string or numeric coercion.
- Keep string-literal escapes fixed to Nunjucks v3.2.4: decode only `\\n`,
  `\\t`, and `\\r`, and treat every other backslash as quoting exactly its next
  source code unit. Do not add JavaScript hexadecimal or Unicode decoding, and
  advance diagnostic positions over each raw string source code unit.
- Keep numeric literals decimal-only: digits followed by an optional decimal
  point and digits, with signs represented as unary nodes. Reject leading-dot,
  exponent, non-decimal radix, separator, and digit-leading symbol-like forms
  during complete parsing; native number conversion must not define syntax.
- Keep regular-expression literal grammar fixed to the parser-owned Nunjucks
  v3.2.4 `gimy` flag set. Reject duplicate or other ASCII-letter flags and
  candidate delimiters preceded by nonzero even backslash runs before
  evaluation; share complete identifier boundaries between tag and expression
  scanning so only an exact `r/` token starts a regex. Native Node.js RegExp
  support must never expand accepted syntax.
- Compare validated primitive strings with direct UTF-16 relational operators.
  Do not use locale-aware collation or `Intl` inside template semantics.
- Centralize property-key, primitive, number, string, addition, relational, and
  equality semantics in closed coercion helpers that dispatch exhaustively by
  runtime value kind. Never reuse output rendering for semantic conversion or
  invoke `valueOf`, `toString`, or another host object hook.
- Implement numeric ordering with explicit less-than, greater-than, and equality
  checks after closed numeric conversion. Never derive ordering by subtraction:
  equal positive or negative infinities must compare equal while `NaN` remains
  unordered.
- Reject callable identities recursively before output rendering, string or
  numeric coercion, serialization, capture, separator construction, scratch
  accounting, or standard-library transformation can turn them into ordinary
  data. Callable predicates and evaluator-owned dispatch are the only standard
  operations that may inspect callable identities.
- Define accepted input kinds and nullish normalization per built-in filter,
  test, and global. Preserve pinned Nunjucks failure behavior instead of using
  a generic empty array, record, string, zero, or false fallback for invalid
  input, and resolve supported keyword arguments by presence rather than
  nullishness.
- Lower built-in filter keywords according to Nunjucks's two calling
  conventions. Bind declared names only for macro-wrapped `int` and `sort`;
  append every other filter's keywords as one closed final positional record
  with an own `__keywords: true` marker. Preserve positional-then-keyword
  evaluation order, reject callables recursively, and never use a host object.
- Handle array-like records per operation rather than through the generic
  sequence path. Preserve direct `first`, raw-length `last`, indexed-loop
  `batch` and `groupby`, map-style `reverse` and `sort`, slice-style `select`
  and `reject`, and cryptographic `random` behavior. Keep record semantics for
  `list`, `length`, `urlencode`, and `dictsort`, and reject record input for
  method-dependent filters such as `join`, `slice`, `sum`, and attribute
  selection. Reserve projected indexed work and scratch slots before iterating
  or allocating sparse record positions.
- Keep attribute semantics filter-specific. `join` and `sum` use one truthy
  direct key; `selectattr` and `rejectattr` always use one direct key, including
  the omitted `undefined` key, apply direct truthiness only, and ignore surplus
  evaluated non-callable arguments; `sort` and `groupby` use an empty path for
  a falsey attribute, split only primitive strings on dots, and treat every
  other truthy value as one direct key. Reject exact reserved direct keys and
  every reserved nested segment, but allow dots inside an otherwise permitted
  direct key. Attribute lookup on null or undefined must fail rather than
  silently becoming absent.
- Preserve closed value types inside built-ins until an operation requires
  coercion. Implement `range` comparison and increments with closed ordering
  and addition, `sum` with ordered closed addition, and `joiner` separators as
  original runtime values; never normalize their state eagerly to numbers or
  strings.
- Keep `sort` and `dictsort` comparators operation-specific. `sort` uses
  pairwise string lowercase normalization plus closed relational ordering;
  `dictsort` independently uppercases strings and applies closed greater-than,
  strict equality, then its pinned `-1` fallback. Do not merge them into a
  generic string comparator or invoke host coercion.
- Preserve each built-in's observable coercion and short-circuit order. Regex
  `replace` must validate string input before numeric conversion and return a
  primitive string; non-regex replacement must preserve raw replacement state
  and unchanged coerced-input identity. `center` and `truncate` must inspect
  the original closed direct length before requiring text, and `wordcount`
  must test closed falsiness before requiring text. Return unchanged values and
  existing safe strings directly where Nunjucks short-circuits; transformed
  output receives a fresh safe identity.
- Preserve filter arguments through original-value defaulting and apply the
  operation-specific numeric rule only where Nunjucks performs it. Do not share
  one integer normalization across repeat-loop bounds, substring positions,
  replacement limits, URL label lengths, round precision, and JSON indentation.
  Keep the deliberate positive-integer validation for `batch` and `slice`,
  including when an ordinary keyword bag reaches their count argument.
- Keep strict built-in option dispatch type-sensitive. `dictsort` accepts only
  absent, primitive `key`, or primitive `value`; `round` selects special methods
  only from primitive strings; and `dump` indentation accepts only primitive
  numbers and strings. Safe strings must not gain authority through coercion.
- Give each directly resolved registered or built-in global one canonical
  sealed callable handle per render. Ordinary array, record, and callable-valued
  built-in member lookup must return a fresh sealed alias carrying only the same
  evaluator-owned kind and ID; scope lookup and loop destructuring retain the
  canonical handle. Use closed strict identity for `switch` case matching.
- Accept array and string indices only after property-key conversion and only
  when the key is the canonical in-range nonnegative integer spelling. Treat
  array membership as strict identity rather than loose equality.
- Match pinned Nunjucks observable mixed-operator grouping rather than assuming
  conventional precedence or copying its parser tree literally. Power is
  left-associative, concatenation participates in the additive emitted tier,
  floor division preserves Nunjucks's wrapped multiplicative behavior,
  relational operators bind above equality, and membership and tests form
  distinct boundaries. Preserve Nunjucks's observable prefix-`not` lowering
  through raw arithmetic and comparison operands rather than normalizing it to
  conventional unary precedence.
- Reject a unary `Neg` whose direct child is `Neg` and a unary `Pos` whose
  direct child is `Pos`. This matches Nunjucks's compiler-derived rejection of
  adjacent `--` and `++`; preserve alternating signs, grouped repeated signs,
  and repeated `not`.
- Require parentheses around an inline conditional nested in another inline
  conditional's else arm. Accept only strings and ordinary identifiers as
  dictionary literal keys; reject literal-looking numeric, boolean, and nullish
  key forms before evaluation.
- Treat parenthesized comma-separated expressions as ordered groups, not arrays.
  Evaluate every child once from left to right, reject callable identities in
  every non-final result before discard, and return only the final value. Reject
  empty groups during complete parsing.
- Accept only one ordinary symbol or a flat comma-separated symbol list as a
  `for` or `set` target. Reject bracketed, grouped, nested, literal, lookup, and
  callable targets while parsing the complete source, before evaluation.
- Plan loops from both the closed container kind and target count. Single-target
  records use only their own raw `length` and numeric entries; multi-target
  records yield key-value pairs, primitive strings yield index-code-unit pairs,
  and arrays destructure through explicit closed numeric lookup. Preserve raw
  record length for loop metadata and else truthiness, and fail before the body
  when multi-target array destructuring encounters null or undefined.
- Clear all host-realm legacy RegExp capture state in a public render-level
  `finally` block. Cover successful and failed renders, and do not claim that
  pre-existing legacy state can be restored.
- Clear legacy RegExp state before every registered filter or global boundary
  and again after argument copying, callback execution, result validation, or
  sanitized exception handling completes. Capabilities must not observe
  template or earlier-capability match state.
- Implement template-visible randomness with Node's cryptographic random
  source. Built-ins must not read or advance the caller realm's shared
  `Math.random` stream.
- Treat capability exceptions as fail-stop opaque values. Preserve details only
  from primitive strings or an own string data descriptor after a trap-free
  native-error brand check, neutralize and bound the detail, discard the
  original thrown value, and never resume template evaluation.
- Complete public API validation before template evaluation. Pass through only
  `NunjitsuLimitError` from evaluation and wrap every other evaluation failure
  in `NunjitsuRenderError`, regardless of its underlying JavaScript error class.
- Public render errors must expose only engine-owned bounded messages, stable
  phase and code fields, and one-based template coordinates. Never retain an
  internal error, stack, thrown capability value, or other original value as
  `cause`; the public `cause` property remains `undefined`.
- Never interpolate raw template source or decoded token values into
  diagnostics. Use the central bounded diagnostic formatter and keep the public
  render-error message independently neutralized and single-line. Escape every
  Unicode `Bidi_Control` character, including U+061C, U+200E, and U+200F.
- Ensure transient JavaScript containers passed to host operations such as
  serialization cannot observe inherited accessors, coercion hooks,
  serialization hooks, or methods.
- Serialize inert regex values through fresh empty null-prototype transient
  records so `dump` and Cookiecutter `jsonify` match native RegExp JSON shape
  without exposing patterns, flags, prototypes, or hooks. Keep `undefined`
  omission and array-null behavior distinct from regex serialization.
- Use explicit coercion helpers. Never call `String`, `Number`, `valueOf`,
  `toString`, iterators, or methods on unvalidated objects.
- Treat every production dependency imported by parser or runtime code as part
  of the trusted computing base and review it accordingly.
- Keep the production parser and standard library dependency-free. Nunjucks is
  a development-only compatibility oracle and benchmark baseline and must not
  be imported by `src/`.
- Maintain automated static checks for prohibited dynamic execution and host
  reflection in parser and interpreter modules.
- Add attack regression tests before fixing any discovered interpreter escape.

## Testing rules

- Prefer fewer thorough tests with related assertions over many tiny tests.
- Put Nunjucks semantic behavior in the shared compatibility corpus rather than
  duplicating fixtures across parser, interpreter, and API tests.
- Never skip or mark an upstream case expected-failing without a parity-manifest
  entry containing provenance and a reason tied to the compatibility contract.
- Every manifest entry marked `ported` or `adapted` must link executable
  coverage through `cases.json` or `coverage.json`. `ported` means all
  applicable assertions in that upstream test are preserved; `adapted` needs a
  reason identifying the deliberate difference. Suite-level coverage ranges
  must be explicit and backed by a test that enumerates the selected behavior.
- When changing the pinned Nunjucks baseline or inventory, compare it against
  an exact upstream checkout with
  `scripts/compat/verifyNunjucksInventory.mjs`.
- Test source `.ts` directly on Node.js 22.18 or newer. When runtime or build
  compatibility changes, validate the built package against the Node.js 22
  package minimum. Also test both built package entry paths and synchronous
  rendering.
- Every failure path must prove that the engine retains no partial render state
  and the next render starts cleanly.
- Security-sensitive parsing, value copying, lookup, coercion, and call changes
  require malformed input tests, gadget regression tests, and fuzz coverage
  where appropriate.
- Keep parser/template and expression benchmark workloads output-equivalent
  across Nunjitsu and pinned Nunjucks. Do not add callback benchmarks or turn
  noisy performance measurements into test thresholds.

## Changesets

- Add a `.changeset/*.md` entry for every change that affects the published
  package. Infrastructure, documentation-only, test-only, and private tooling
  changes do not require one.
- Create and inspect changeset files through direct file operations rather than
  invoking Changesets CLI commands. Each entry must name `nunjitsu`, select the
  correct semantic bump, and describe the user-visible package change.
- Run `pnpm version:packages` only when intentionally preparing a release. It
  consumes pending entries, updates `package.json` and `CHANGELOG.md`, and the
  resulting version change must be committed before creating its matching tag.

## Documentation rules

- Keep `README.md` focused on the project introduction, high-level goals,
  current status, installation, complete public TypeScript API reference,
  minimal development setup, and links into `docs/`.
- Put design details in the page that owns the area. Add a new focused page only
  when no existing page has clear ownership, and link it from `docs/index.md`.
- Documentation describes the current intended design, not a chronological log.
  Replace superseded guidance and explain the reason in the change description.
- Update documentation in the same change as behavior. Do not defer it to a
  follow-up.
- Do not create standalone findings, investigation, or implementation-summary
  documents unless explicitly requested.
- Preserve upstream attribution and licensing adjacent to copied test material.

## General code quality

- Follow the existing style of each file and language. Do not mix styles within
  a file.
- Keep `index.ts` files as thin public entrypoints that generally only
  re-export declarations from responsibility-focused modules. Do not place
  substantial implementation in index files or add format-specific entrypoints.
- When a module exists primarily to provide one main export, name the file
  after that export, including its casing, such as `createEngine.ts` for
  `createEngine`.
- Add comments only for non-obvious invariants, architecture, or intentionally
  surprising behavior. Prefer self-explanatory names and types.
- Keep security and memory ownership visible in APIs. Reject invalid states at
  boundaries rather than compensating for them deeper in the engine.
- Avoid speculative abstractions and persistent caches. Add complexity only for
  a measured need that fits the documented optimization target.
