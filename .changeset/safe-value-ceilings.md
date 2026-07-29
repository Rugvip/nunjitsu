---
"nunjitsu": patch
---

Bound safe-value copying with fixed nesting, structured-entry, and prepared-context path ceilings so pathological context and capability-result graphs fail deterministically instead of exhausting the JavaScript stack or expanding enormous sparse arrays.
