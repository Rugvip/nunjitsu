---
"nunjitsu": patch
---

Treat empty safe-string wrappers as truthy across control flow, filters, globals, and loop metadata, matching Nunjucks and preserving fail-stop string slice behavior.
