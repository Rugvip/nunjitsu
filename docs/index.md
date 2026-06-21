# Nunjitsu documentation

This directory contains the normative design documentation for Nunjitsu. The
root [README](../README.md) introduces the project; implementation rationale,
constraints, and cross-cutting decisions belong here.

## Architecture map

| Area | Document | Scope |
| --- | --- | --- |
| System design | [Architecture](architecture.md) | Components, ownership, render lifecycle, and repository boundaries |
| Execution core | [Runtime and memory](runtime-and-memory.md) | Workers, Wasm ABI, fixed memory layout, parsing, evaluation, and reclamation |
| Trust boundary | [Security](security.md) | Threat model, safe values, capabilities, loaders, and resource limits |
| Compatibility | [Nunjucks compatibility](compatibility.md) | v3.2.4 contract, intentional deviations, and attribution |
| Host API | [TypeScript API](typescript-api.md) | Engine lifecycle, rendering, streams, packaging, and source constraints |
| Verification | [Testing](testing.md) | Shared upstream corpus, test layers, fuzzing, and release gates |

## Reading order

Start with [Architecture](architecture.md). Read the area page for any part of
the system you change. Contributors and coding agents must also follow the
root [AGENTS.md](../AGENTS.md).

## Documentation policy

These pages describe the intended architecture, including code that has not
been implemented yet. They use **must**, **must not**, and **only** for settled
constraints. Implementation must not silently diverge from them.

When a change affects a cross-cutting decision:

1. Update the relevant page in the same change as the implementation.
2. Update `docs/index.md` when a page is added, removed, or changes scope.
3. Update `AGENTS.md` when the decision constrains work across the repository.
4. Explain the old constraint, the new constraint, and the reason for changing
   it. Do not leave conflicting historical guidance in active documentation.

Use focused pages rather than growing a single design document. Avoid
standalone investigation or findings documents; integrate durable knowledge
into the page that owns the topic.
