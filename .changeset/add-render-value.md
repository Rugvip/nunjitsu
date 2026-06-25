---
"nunjitsu": minor
---

Add `TemplateRenderer.renderValue` for rendering complete templates while
preserving the native value of a sole interpolation. Templates containing text,
multiple interpolations, or statements continue to return rendered strings.
