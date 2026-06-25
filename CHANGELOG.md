# nunjitsu

## 0.3.0

### Minor Changes

- Add `TemplateRenderer.renderValue` for rendering complete templates while
  preserving the native value of a sole interpolation. Templates containing text,
  multiple interpolations, or statements continue to return rendered strings.

### Patch Changes

- Streamline the README API documentation by removing overly detailed security
  guidance.

## 0.2.0

### Minor Changes

- Replace the generic engine API with named template-renderer exports, including
  `createTemplateRenderer`, `TemplateRenderer`, the corresponding option,
  context, and limit types, and `TemplateRenderError` and `TemplateLimitError`.
  The package continues to provide named exports only.

## 0.1.1

### Patch Changes

- Centralize host-hook-free coercion, equality, ordering, lookup, and membership
  while aligning UTF-16 strings, safe strings, regular expressions, sparse
  arrays, record order, and prepared-context presence with Nunjucks.
- Align complete-source parsing with Nunjucks across literal grammar, expression
  grouping, comments, whitespace, raw regions, declarations, call blocks,
  conditionals, switches, and synchronous filter blocks.
- Match Nunjucks macro and caller argument binding, lexical exports, callable
  identity, loop destructuring, compiler-slot lifetime, branch-specific scope,
  and stateful cycler behavior.
- Align built-in filters, tests, and globals with Nunjucks across accepted input
  types, keyword binding, attribute projection, numeric conversion, sorting,
  slicing, short-circuits, serialization, and array-like records.
- Harden the closed value boundary against proxy-backed data, inherited iteration
  and serialization hooks, reserved prototype keys, repeated alias expansion,
  ambient RegExp state, and access to the host `Math.random` stream.
- License the package under the MIT License.
- Route filters and globals through sealed callable identities, support validated
  dotted filter IDs, reject callable authority at non-macro boundaries, validate
  operations before operands, and restrict call blocks to template macros.
- Streamline the published package README around installation, the primary
  TypeScript API, contributor setup, and links to focused compatibility and
  security guidance.
- Return consistent, cause-free render errors with precise template locations,
  bounded diagnostics, complete control and bidirectional-character escaping, and
  safe capability failure details.

## 0.1.0

### Minor Changes

- Initial secure direct-string template engine release with ESM, CommonJS, and
  TypeScript declarations.
