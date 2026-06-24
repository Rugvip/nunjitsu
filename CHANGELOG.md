# nunjitsu

## 0.1.1

### Patch Changes

- df7467a: Centralize host-hook-free coercion, equality, ordering, lookup, and membership
  while aligning UTF-16 strings, safe strings, regular expressions, sparse
  arrays, record order, and prepared-context presence with Nunjucks.
- df7467a: Align complete-source parsing with Nunjucks across literal grammar, expression
  grouping, comments, whitespace, raw regions, declarations, call blocks,
  conditionals, switches, and synchronous filter blocks.
- df7467a: Match Nunjucks macro and caller argument binding, lexical exports, callable
  identity, loop destructuring, compiler-slot lifetime, branch-specific scope,
  and stateful cycler behavior.
- df7467a: Align built-in filters, tests, and globals with Nunjucks across accepted input
  types, keyword binding, attribute projection, numeric conversion, sorting,
  slicing, short-circuits, serialization, and array-like records.
- df7467a: Harden the closed value boundary against proxy-backed data, inherited iteration
  and serialization hooks, reserved prototype keys, repeated alias expansion,
  ambient RegExp state, and access to the host `Math.random` stream.
- df7467a: License the package under the MIT License.
- df7467a: Route filters and globals through sealed callable identities, support validated
  dotted filter IDs, reject callable authority at non-macro boundaries, validate
  operations before operands, and restrict call blocks to template macros.
- 6556b8a: Streamline the published package README around installation, the primary
  TypeScript API, contributor setup, and links to focused compatibility and
  security guidance.
- df7467a: Return consistent, cause-free render errors with precise template locations,
  bounded diagnostics, complete control and bidirectional-character escaping, and
  safe capability failure details.

## 0.1.0

### Minor Changes

- Initial secure direct-string template engine release with ESM, CommonJS, and
  TypeScript declarations.
