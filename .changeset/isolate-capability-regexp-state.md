---
'nunjitsu': patch
---

Clear legacy RegExp capture state around every registered filter and global
invocation so template regex operations cannot pass ambient data to host
capabilities.
