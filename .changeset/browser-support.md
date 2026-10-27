---
"nunjitsu": minor
---

Add a browser ESM build selected through the browser export condition, with the
same synchronous rendering API and no Node.js polyfills. Browser inputs must be
trusted application-created objects because proxy detection is unavailable.
