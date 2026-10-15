---
"nunjitsu": patch
---

Added opt-in JSON coercion to `renderValue` for compatibility with legacy Backstage Scaffolder value templates. Single non-text root nodes can return decoded JSON values, with ordinary text fallback and empty output becoming `undefined`. Default value rendering and ordinary string rendering are unchanged.
