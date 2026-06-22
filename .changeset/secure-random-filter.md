---
'nunjitsu': patch
---

Use Node's cryptographic random source for the `random` filter so templates
cannot observe or advance the host application's `Math.random` stream.
