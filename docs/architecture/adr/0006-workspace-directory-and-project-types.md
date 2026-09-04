# ADR-0006: Workspace Directory and Project Types

- Status: Accepted
- Date: 2026-09-04

## Context

ATape URLs and Canonical records are already Team- and Project-scoped, but the Web shell still presents one hard-coded Team and Project. That makes the visible navigation context disagree with the data model and leaves no stable entry point for future CLI setup, Raw inspection, or Team-level policy.

Project setup must distinguish a Git repository from an ordinary directory. The server must never receive a user's local path merely to render navigation. A captured Project must also not silently move between Teams or change identity because a later Adapter observation contains different metadata.

## Considered Designs

### Derive a flat Project list from conversation reads

Add all Projects to the existing Project Memory response and infer Team labels from Team IDs. This avoids a Module, but Project Memory would own global navigation, every page would need unrelated conversation data, and Team display identity would remain lossy.

### Let each page fetch Team and Project rows directly

Expose separate table-shaped endpoints and let the Web application join, sort, count, and select them. This keeps storage simple but moves directory reconstruction and consistency into every presentation client.

### Expose one Workspace Directory snapshot

Persist Team identity and typed Project identity beside Canonical ownership metadata. A Workspace Module reconstructs one ordered directory snapshot with navigation counts behind a single operation. HTTP and Web presentation consume that snapshot without knowing storage joins.

## Decision

ATape uses a Workspace Directory Module and explicit Project types.

- `workspace.Directory.Open` returns all visible Teams and their Projects as one consistently ordered snapshot.
- The consumer-owned `workspace.DirectoryStore` Seam exposes one snapshot operation. PostgreSQL and the in-memory development Store are its two Adapters.
- `GET /api/v1/workspace` is the v0.1 read Interface. It returns Team identity and Project navigation summaries without Session or Event payloads.
- A Project has an immutable `type` of `git` or `directory`.
- `git` means the client setup selected a Git repository. `directory` means the user explicitly selected an ordinary folder. Local filesystem paths are client configuration and are never included in this server model.
- Team ID/name and Project ID/Team/type/name are immutable when observed through Canonical ingestion. A future explicit management operation may define directory-display renaming; ingestion never performs it implicitly.
- The internal alpha Canonical ingestion envelope carries `project.teamName` and `project.type` while project creation remains observation-driven. A future setup API may register the same records before the first Session without changing the Directory read Interface.
- Project IDs remain globally unique in v0.1. Moving captured history between Teams is not supported.
- The Web shell obtains remote Workspace state through an Effect Module and Browser Adapter. The View owns only disclosure/focus state for the switcher.
- All Team members remain able to see all Projects in a Team; fine-grained authorization is deferred as previously decided.

## Consequences

- The visible Team and Project context now comes from server data instead of route-specific hard-coded labels.
- New navigation consumers gain Team grouping, Project type, activity counts, and capture watermarks without learning Canonical table layout.
- Git and ordinary-directory setup can evolve separately while sharing the same downstream Session, Search, and Raw product surfaces.
- The internal ingestion alpha gains two required fields. Existing development fixtures and clients must update before the public Adapter SDK is stabilized.
- Renaming and moving are intentionally absent from this slice; adding them requires an explicit command with separate identity rules.

## Rejected Alternatives

- **Flat Project list inside Project Memory**: couples global navigation to one conversation page and creates redundant fetches.
- **Table-shaped Team and Project endpoints**: leaks grouping and aggregation work into presentation clients.
- **Client-local Workspace navigation only**: prevents teammates and multiple devices from sharing the same server-side Project identity.
- **Uploading local paths**: exposes machine-specific data that the server does not need and cannot use safely.
