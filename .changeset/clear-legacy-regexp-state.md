---
"nunjitsu": patch
---

Clear host-realm legacy RegExp capture state after every successful or failed
render so template-controlled matches cannot survive the render boundary.
