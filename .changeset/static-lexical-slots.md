---
'nunjitsu': patch
---

Bind compiler-selected lexical slots before evaluation so inactive macro declarations cannot fall through to registered capabilities, while preserving direct positional, caller, loop-target, and reassigned slot behavior.
