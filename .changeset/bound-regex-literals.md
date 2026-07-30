---
"nunjitsu": patch
---

Bound every template regular-expression pattern to 16,384 UTF-16 code units
before native syntax validation, preventing oversized literals from consuming
unbounded compilation resources even when regular-expression execution is
disabled.
