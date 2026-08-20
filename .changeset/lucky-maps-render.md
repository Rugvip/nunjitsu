---
'nunjitsu': minor
---

Add closed intrinsic methods for strings, numbers, arrays, Maps, Sets, and enabled regular expressions. Map and Set values now cross context, capability, prepared-context, and `renderValue` boundaries as detached snapshots, while collection mutations remain local to one render.
