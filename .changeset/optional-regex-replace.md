---
"nunjitsu": minor
---

Disable template-controlled regular-expression execution in the built-in
`replace` filter by default. Set `allowRegexExecution: true` when creating a
renderer to retain native Nunjucks-compatible regex replacement. String
replacement and inert regular-expression literals remain available.
