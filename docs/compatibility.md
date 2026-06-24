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

- `${{ ... }}` interpolation, `{% ... %}` statements, and opaque `{# ... #}`
  comments that close at the first exact `#}` without quote or nesting syntax;
- Cookiecutter `{{ ... }}` mode and its `jsonify` alias;
- expressions, truthiness, scoping, loops, inline macros, call blocks, and
  rendering semantics used within one source;
- call-block caller signatures containing regex literals, including escaped or
  character-class parentheses and regexes nested in closed expressions;
- block conditionals with equivalent `elif` and `elseif` continuations, nested
  mixed chains, final `else`, and complete malformed-branch validation;
- synchronous `{% filter ... %}` blocks with built-in or exact dotted
  application filters, nested bodies, ordinary statements, and explicit
  arguments evaluated after body capture;
- object-like truthiness for safe-string wrappers even when their wrapped text
  is empty, while explicit text length and iteration remain content-based;
- lexical and context shadowing when resolving callable globals;
- presence-based macro defaults that preserve explicit null, undefined, and
  falsey arguments;
- lexical macro export frames across root, blocks, loops, ordinary macros,
  conditionals, switches, and synthetic callers, without dynamic capture of
  loop variables or outer-macro arguments;
- stable root lexical `set` and macro bindings alongside independently updated
  macro exports, so root expressions and separately evaluated block or macro
  bodies retain Nunjucks-compatible collision behavior;
- Nunjucks-compatible UTF-16 code-unit semantics for string length, lookup,
  iteration, ordering, filters, replacement, and Jinja-compatible slicing;
- pinned Jinja slice lookup semantics, including raw fractional and string
  bounds, one-time negative adjustment, and missing entries at visited keys;
- explicit Nunjucks-compatible strict and loose equality over closed values;
- Nunjucks-compatible closed primitive, property-key, numeric, concatenation,
  lookup, membership, and relational coercion without host object hooks;
- JavaScript-compatible numeric ordering after closed conversion, including
  equal positive and negative infinities and unordered `NaN` values;
- observable Nunjucks mixed-operator grouping, including left-associative
  exponentiation, concatenation in the emitted additive tier, and wrapped
  floor-division behavior among multiplicative operators;
- observable comparison, membership, test, and prefix-`not` grouping, including
  Nunjucks's generated-code behavior where it differs from conventional unary
  precedence;
- parenthesized comma-expression groups that evaluate children left to right
  and return the final value, with empty groups rejected before execution;
- compiler-derived rejection of repeated unparenthesized `--` and `++` unary
  shapes while preserving alternating, parenthesized, and repeated-`not` forms;
- the pinned string-literal escape grammar, where only `\\n`, `\\t`, and
  `\\r` decode specially and every other backslash removes itself while
  preserving the immediately following source character;
- a decimal-only numeric literal grammar consisting of digits followed by an
  optional decimal point and zero or more digits, with signs represented by
  ordinary unary operators;
- a fixed regular-expression literal grammar with only the Nunjucks v3.2.4
  `g`, `i`, `m`, and `y` flags, independent of flags added by later Node.js
  releases;
- canonical Nunjucks regex string coercion for empty patterns, raw line
  terminators, and flag order across output, closed operations, and capability
  arguments, while `dump` and `jsonify` retain empty-object serialization;
- Nunjucks parser acceptance for parenthesized nested inline conditionals and
  string or ordinary-identifier dictionary keys;
- target-count-sensitive Nunjucks loop behavior for arrays, primitive and safe
  strings, and array-like or key-value records, including raw loop-length
  metadata, else selection, and flat symbol-only binding targets;
- render-local canonical identity for direct callable globals, fresh sealed
  identity for ordinary callable member lookup, and strict identity-based
  switch matching;
- switch statements with at least one `case` or `default`, including empty arm
  bodies and empty-case fallthrough; comments alone do not constitute an arm;
- declaration-specific macro and caller validation, Nunjucks positional/default
  ordering, positional call arguments after keywords, and complete structural
  tag validation including named blocks and raw regions;
- separate Nunjucks whitespace domains for full template-data trimming and the
  restricted space, tab, LF, CR, and NBSP code-token set;
- depth-aware same-name raw and verbatim regions, including literal mixed
  markers and pinned opening/closing whitespace-control behavior;
- built-in filters, tests, and globals used by direct string templates;
- pinned built-in input domains, nullish normalization, keyword arguments, and
  fail-before-later-capability behavior over the closed value model;
- operation-specific array-like record behavior for indexed collection filters,
  including sparse values and malformed-length failure ordering;
- filter-specific direct-key and dotted getter-path attribute semantics over
  records, arrays, and strings;
- JavaScript property enumeration order for literal, copied, updated, and
  built-in-derived records;
- operation-specific stable `sort` and `dictsort` comparison semantics over
  mixed closed values, including their distinct case normalization rules;
- operation-ordered `replace` coercion and safe-string identity preservation
  for unchanged `replace`, `center`, `truncate`, and `string` results;
- raw-length and falsiness short-circuits before text validation in `center`,
  `truncate`, and `wordcount`;
- type-preserving `range`, `sum`, and `joiner` behavior, including JavaScript-
  style ordered comparison and addition without eager normalization;
- Nunjucks-specific numeric argument behavior for spacing, truncation,
  replacement limits, URL labels, round precision, and JSON indentation;
- strict primitive option selection for `dictsort`, `round`, and `dump`;
- macro-bound `int` and `sort` keywords plus closed Nunjucks keyword bags for
  every ordinary built-in filter;
- synchronous application filters and `TemplateValue` data or callable globals;
- exact dotted application-filter names with ordinary code whitespace around
  dots, without object traversal or namespace semantics;
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

Macro declarations inside block-set and filter-block captures are rejected
during complete parsing. Pinned Nunjucks encounters generated-code scope errors
for some such placements; Nunjitsu consistently fails closed rather than
exposing capture-dependent declaration behavior.

Call blocks accept only direct or static constant-key macro references. They
reject effectful target expressions during parsing and reject non-macro targets
before evaluating call arguments or registering the caller body. Unknown
filters and tests are likewise rejected before their operands and arguments,
and `select` and `reject` validate a named test even for empty inputs. These
fail-closed ordering rules intentionally take precedence over Nunjucks behavior
where its generated JavaScript would evaluate otherwise-unused expressions.

Nunjucks also permits callable values in ignored keyword and surplus arguments,
and its stateful globals can retain JavaScript functions. Nunjitsu intentionally
rejects those forms: registered filters and globals are positional-only,
stateful built-ins cannot retain sealed callables, ignored method arguments are
invalid, and built-in tests enforce exact arity. Macro-to-macro caller
forwarding, the `callable` test, and closed callable identity comparisons remain
supported because they preserve authority inside explicit interpreter-owned
semantics rather than discarding or transforming it.

Numeric filter arguments are not normalized through one integer helper.
Nunjitsu preserves the original closed value until each filter reaches the
specific JavaScript operation represented by pinned Nunjucks: repeat-loop
bounds for `center` and `indent`, `substring` positions for `truncate`, direct
counter comparison for `replace`, `substr` length for `urlize`, exponent
precision for `round`, and JSON number/string indentation for `dump`. Infinite
spacing fails closed instead of reproducing an unbounded upstream loop. The
documented positive-integer restrictions for `batch` and `slice` are unchanged.

Array-like records are consumed only by filters whose pinned implementation
performs indexed record access. `first` reads key `0` without consulting
`length`; `last` derives one key from the raw length; `batch` and `groupby`
perform indexed comparison loops; `reverse` and `sort` preserve map-style raw
numeric length validation; and `select` and `reject` use slice-style length and
presence semantics. `random` selects the derived record index with Node's
cryptographic source rather than the host `Math.random` stream. Sparse positions
remain absent for selection but become closed `undefined` where the pinned
algorithm performs a direct indexed read.

This support does not turn records into generic sequences. `join`, `slice`,
`sum`, `selectattr`, and `rejectattr` still reject them because Nunjucks requires
array methods on those paths. `list`, `length`, `urlencode`, and `dictsort`
retain record/key-value semantics. Numeric, numeric-string, nullish, invalid,
negative, and fractional lengths follow the coercion and failure behavior of
the individual operation rather than one shared integer normalization.

Attribute-bearing filters likewise retain separate policies. `join` and `sum`
perform one direct lookup only when their attribute is truthy. `selectattr` and
`rejectattr` always convert the supplied or omitted attribute to one direct
property key and select by that value's direct truthiness. They do not resolve a
named test: surplus positional values and keyword bags are evaluated in source
order, recursively callable-checked, and otherwise ignored. `sort` and
`groupby` use an empty identity path for falsey values, split only truthy
primitive strings on dots, and treat safe strings and other truthy closed values
as one direct key. Empty safe strings are therefore direct empty keys while
empty primitive strings disable lookup for the applicable filter. Nullish
collection elements fail when a non-empty lookup is attempted; missing
properties on other closed values remain absent.

Closed records enumerate canonical array-index keys from `0` through
`4294967294` first in ascending numeric order, then all remaining string keys
in first-insertion order. Padded numbers, negative numbers, and `4294967295`
remain named keys. Duplicate assignment replaces the value without moving a
named key. This invariant applies equally to literals, copied contexts,
prepared-context path updates, and derived records such as `groupby`, so loops,
`list`, `urlencode`, `dump`, and capability call order observe one policy.

`sort` and `dictsort` deliberately use different closed comparators. `sort`
lowercases only pairs of string-like values in case-insensitive mode, then uses
closed JavaScript-style relational ordering and preserves stable input order
when values are equal or unordered. `dictsort` uppercases each string operand
independently in case-insensitive mode, returns greater-than first, then closed
strict equality, and otherwise returns `-1`, matching Nunjucks's unusual
observable comparator for mixed and Unicode values.

`replace` preserves Nunjucks's observable operation order. Regex search is
dispatched before numeric input conversion, accepts only primitive or safe
strings, returns an ordinary primitive string, and fails before later
capabilities for other input kinds. Non-regex replacement converts numeric
input before zero-limit and no-match returns, rejects safe-string search values
as unsupported, and retains the original safe-string identity when unchanged.
The empty-search path keeps an absent replacement distinct so array joining
uses its default comma separator. Unchanged `center`, `truncate`, and `string`
paths likewise retain an existing safe-string identity, while changed output
creates a fresh value.

`center` and `truncate` normalize only null, undefined, and false before reading
the closed equivalent of the input's direct `length` property. Strings and
arrays expose their intrinsic length, records expose their own `length` entry,
and other closed values expose no length. Closed relational comparison against
the original width or truncation limit decides whether the original normalized
value is returned before any text requirement. `wordcount` similarly returns
null for a falsey normalized value before requiring string input. Recursive
callable rejection still precedes every one of these short-circuits.

Option dispatch remains type-sensitive where Nunjucks uses strict JavaScript
checks. `dictsort` accepts an absent selector or the exact primitive strings
`key` and `value`; null and safe-string wrappers are invalid. `round` recognizes
only primitive `ceil` and `floor` strings and otherwise uses ordinary rounding.
`dump` accepts indentation only from primitive numbers and primitive strings,
so safe strings and all other closed values produce compact JSON. String
indentation remains limited to ten UTF-16 code units and positive numeric
indentation remains truncated and clamped to ten. Inert regex values serialize
as empty objects, matching native RegExp enumerable JSON shape without exposing
their source or flags. This applies recursively to arrays, records, ordinary
keyword bags, and the Cookiecutter `jsonify` alias; `undefined` retains native
JSON omission or array-null behavior and remains distinct.

Built-in filter keyword syntax follows the pinned compiler calling convention.
`int` binds `default` and `base`, while `sort` binds `reverse`,
`case_sensitive`, and `attribute`; unknown names remain evaluated but unused.
Every other built-in receives one final positional `RuntimeRecord` containing
all keyword values and an own `__keywords` marker set to true. Positional
expressions, including those written after keyword syntax, evaluate first in
their source order, followed by keyword expressions in source order. This
preserves the intentionally unusual observable behavior of filters such as
`default`, `center`, `join`, `select`, and `round` without exposing a host
keyword object. The positive-integer restrictions for `batch` and `slice`
remain deliberate deviations when such a bag reaches their count argument.

Jinja subscript slicing is distinct from the `slice` filter. It operates
directly on the original closed target rather than materializing and clamping a
conventional sequence. Start, stop, step, index, and raw length retain their
closed values; negative bounds add the length once; each visited key uses
closed property-key conversion; and iteration advances through JavaScript-style
closed addition. An explicit stop beyond the target can therefore visit the
`length` index and append `undefined`, while fractional and string indices can
visit non-canonical missing keys. Arrays, array-like records, truthy scalars,
and primitive strings follow this loop. Safe-string targets retain Nunjitsu's
documented closed-text indexing rather than Nunjucks's accidental wrapper gaps.

Steps whose numeric coercion is zero or non-finite fail closed instead of
reproducing an upstream non-progressing loop. Other finite paths remain bounded
by cooperative work and scratch limits.

Whitespace controls operate on template data rather than code tokens. `-`
controls and `lstripBlocks` remove the full ECMAScript whitespace set, including
NBSP, Unicode spacing characters, vertical tab, form feed, and BOM. Inside
expressions and structural tags, only space, tab, LF, CR, and NBSP are code
whitespace; other spacing characters are rejected rather than normalized or
silently skipped. The same rules apply in default and Cookiecutter modes.

Raw and verbatim regions count nested openers of their own name and close only
when that depth returns to zero. Nested markers remain in rendered text, and a
`raw` marker inside `verbatim` or a `verbatim` marker inside `raw` has no special
meaning. An opening `{%- raw %}` or `{%- verbatim %}` applies ordinary left
trimming, while an opening right hyphen does not trim raw content. Hyphenated
closing markers are rejected, matching pinned Nunjucks v3.2.4.

Top-level raw openers use the ordinary code-token whitespace grammar. After
raw mode begins, inner same-name markers instead accept the full ECMAScript
whitespace set around their names and accept no left or right hyphen. A
hyphenated nested opener or closer is therefore preserved as literal raw text.
LF and CRLF remain valid in non-terminal nested markers, but a depth-zero
terminal closer containing LF is rejected to reproduce the pinned oracle's
observable failure safely; a lone CR remains accepted.

Nunjucks parses recursive unary signs but emits adjacent identical signs as
JavaScript `--` or `++`, which fails compilation for template operands. Nunjitsu
reproduces that observable result directly in its closed parser: `Neg(Neg)` and
`Pos(Pos)` fail complete-source validation regardless of whitespace or syntax
position. An explicit group separates the nodes, alternating signs remain
valid, and repeated `not` remains valid.

String literals do not use JavaScript hexadecimal or Unicode escape decoding.
Only `\\n`, `\\t`, and `\\r` produce control characters. Every other escape,
including `\\b`, `\\f`, `\\v`, `\\xNN`, `\\uNNNN`, malformed escape-looking
text, quotes, and backslashes, consumes the backslash and appends its next code
unit unchanged. A doubled backslash therefore preserves one literal backslash
before subsequent `x` or `u` text. Token positions advance over every raw source
code unit, including raw and backslash-escaped newlines.

Numeric literals accept digits followed by an optional decimal point and zero
or more following digits. Leading-zero integers and fractions, trailing decimal
points, unary signs, very large digit-only values, and overflow produced by
supported arithmetic retain pinned behavior. Leading-dot fractions,
hexadecimal, binary, octal, exponent, separator, and identifier-suffixed forms
fail complete-source parsing. Nunjucks may treat some digit-leading forms such
as `1e3` or `0x10` as lookup symbols; Nunjitsu intentionally rejects them rather
than expanding identifier, binding, or capability-name grammar.

Regular-expression literals remain inert pattern and flag data in the AST.
Only `g`, `i`, `m`, and `y` are accepted, duplicates and any other ASCII-letter
flag are rejected during complete-source parsing, and native `RegExp` is used
only to validate the already-constrained pattern. Complete-tag scanning consumes
the same full ASCII identifier tokens as expression tokenization and recognizes
a regex only when that token is exactly `r` followed immediately by `/`; names
such as `bar` and `order` therefore retain adjacent division semantics. Ordinary
`\/` delimiters are accepted. A candidate delimiter preceded by a nonzero even
run of backslashes is rejected as an intentional fail-closed deviation from
Nunjucks's ambiguous immediate-previous-character scanner; an odd run continues
to escape the slash.

Safe strings are internal text values rather than emulations of Nunjucks's
prototype-bearing JavaScript `String` wrapper. Collection filters therefore
treat them consistently as primitive UTF-16 text instead of reproducing wrapper
indexing gaps that can yield `undefined`. Callable identities are also rejected
where Nunjucks might stringify, serialize, or silently discard a JavaScript
function; this preserves the closed capability boundary.

Boolean conversion is the deliberate exception to text-like safe-string
operations. A safe string is a sealed object-like runtime value and is always
truthy, including when it wraps empty text. Operations that explicitly inspect
text length, numeric indices, or iteration continue to use the wrapped UTF-16
content. This distinction also preserves Nunjucks's argument defaulting,
selection filters, loop-else behavior, and fail-stop filter ordering.

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
