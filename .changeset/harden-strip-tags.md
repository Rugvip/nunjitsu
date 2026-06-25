---
"nunjitsu": patch
---

Harden `striptags` against nested markup that could expose a new HTML tag after
the first removal pass. Excessively nested overlapping markup now fails closed.
