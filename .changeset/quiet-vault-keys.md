---
"nunjitsu": patch
---

Fixed dotted lookups of property names that start with digits, such as `values.1password`, to match Nunjucks. Numeric-only dotted segments still require bracket syntax.
