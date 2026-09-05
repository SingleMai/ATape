# ATape Architecture Manual

This directory is the engineering source of truth for ATape. It governs code shape across the TypeScript applications and the Go server. Product decisions explain what ATape does; this manual explains how implementations preserve those decisions.

## Read order

1. [Codebase design](codebase-design.md) defines the shared vocabulary and Deep Module rules.
2. [TypeScript and Effect](typescript-effect.md) defines the Web, CLI, Collector, and Adapter Host rules.
3. [Go server](go.md) defines the server Modules, Composition Root, concurrency, persistence, and transport rules.
4. [Sources and attribution](sources.md) records the external material that informed this manual.
5. [Architecture decisions](adr/README.md) records accepted implementation choices and their consequences.

## Governing model

```text
Presentation
    |
    v
Module Interface  <- caller and test surface
    |
    v
Deep Implementation
    |
    +-- private in-process collaborators
    +-- local-substitutable dependencies
    +-- Adapter at a justified external Seam
```

The dependency direction always points inward toward the Module Interface. Presentation and infrastructure may depend on a Module; the Module must not depend on Web views, CLI rendering, HTTP handlers, Fx, or a specific transport.

## Cross-language correspondence

| Architectural role | TypeScript | Go |
| --- | --- | --- |
| Pure domain model | Data types, Schema, pure functions | Structs, value types, pure functions |
| Module Interface | Effect program and required Effect Services | Exported type/methods or a small consumer-owned interface |
| Implementation | Effect workflows and private collaborators | Package-private implementation |
| Adapter | Effect Layer for Browser, Node, or a remote system | Concrete transport or external-system implementation |
| Presentation | Web ViewModel binding or CLI command renderer | HTTP/RPC handler |
| Composition Root | One application runtime per executable | `cmd/<executable>` with optional Fx wiring |

The rows are conceptual equivalents, not an instruction to imitate one language in the other.

## Project-level invariants

- Session, Thread, and Canonical Event semantics live in shared domain Modules, not in pages or handlers.
- Raw storage is not joined into Canonical read paths by default.
- Search is a Canonical-derived read model and may be eventually consistent.
- Provider-specific knowledge ends at the client-side Adapter implementation.
- At-least-once transport and exactly-once server effect are hidden behind ingestion Interfaces.
- Source deletion does not imply deletion of captured ATape history.
- Every background task has an owner, cancellation path, bounded concurrency policy, and observable failure mode.

## Change protocol

Before adding a new Module or Seam, answer these questions in the PR or ADR:

1. What complexity disappears for callers?
2. What is the complete Interface, including invariants, ordering, errors, and performance expectations?
3. Why is this Seam placed here?
4. Which Adapters make the Seam real?
5. Can tests verify behavior through the public Interface?
6. If the Module were deleted, where would its complexity reappear?

For consequential Interfaces, design at least two substantially different shapes before selecting one.

## Status

The architectural rules are accepted. Exact implementation choices are recorded in the ADR index. ADR-0017 fixes the Go HTTP Adapter on a closed route registry over the standard-library router.
