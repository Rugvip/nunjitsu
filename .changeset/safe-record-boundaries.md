---
"nunjitsu": patch
---

Fix reserved-name smuggling through `groupby` by rejecting synthesized prototype keys before they can cross into registered capabilities.
