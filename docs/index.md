# Nunjitsu documentation

This directory contains the normative design documentation for Nunjitsu. The
root [README](../README.md) introduces the package, its primary TypeScript API,
and the contributor workflow; detailed behavior, implementation rationale,
constraints, and cross-cutting decisions belong here.

## Architecture map

| Area | Document | Scope |
| --- | --- | --- |
| System design | [Architecture](architecture.md) | Components, ownership, render lifecycle, and repository boundaries |
| Execution core | [Runtime and interpreter](runtime-and-memory.md) | Closed values, AST parsing, evaluation, output, and cooperative limits |
| Trust boundary | [Security](security.md) | Threat model, safe values, capabilities, and resource limits |
| Compatibility | [Nunjucks compatibility](compatibility.md) | v3.2.4 contract, intentional deviations, and attribution |
| Verification | [Testing](testing.md) | Shared upstream corpus, regression layers, CI, and benchmarks |
| Release operations | [Releasing](releasing.md) | Package identity, trusted publishing, and release invariants |

## Reading order

Start with [Architecture](architecture.md). Read the area page for any part of
the system you change. Contributors and coding agents must also follow the
root [AGENTS.md](../AGENTS.md).

## Documentation policy

These pages describe the current intended architecture and implemented public
contract. Any planned behavior that is not implemented must be labeled
explicitly. They use **must**, **must not**, and **only** for settled
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
