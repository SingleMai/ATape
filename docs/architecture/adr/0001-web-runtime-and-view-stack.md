# ADR-0001: Web Runtime and View Stack

- Status: Accepted
- Date: 2026-09-04

## Context

ATape's Web application is an authenticated product interface rather than a public content site. Its primary experience requires durable URL state for Team, Project, Session, Thread, search query, and precise Event positioning. The project also requires presentation and application logic to remain separate, with Effect owning asynchronous workflows, dependencies, typed failures, and remote state.

ATape is a greenfield project. Starting on Effect v3 would introduce a near-term migration to v4, whose package organization and several core interfaces have changed. Effect v4 is still a release candidate, so adopting it requires stricter version and unstable-import controls.

## Decision

The v0.1 Web application uses:

- React 19 for rendering;
- Vite 8 for local development and production bundling;
- TanStack Router 1.x for routes and validated URL state;
- Effect 4 RC as the application runtime;
- `@effect/atom-react` at the Presenter-to-View binding;
- Effect Schema for untrusted data at application Seams;
- ATape-owned design tokens and CSS for visual implementation.

TanStack Query, Redux, Zustand, and equivalent general-purpose remote-state stores are not part of the foundation. Router owns serializable navigation state, Effect owns workflow and remote business state, and React owns short-lived visual interaction state.

## Dependency policy

- All Effect ecosystem packages use one exact RC version.
- Effect dependencies are exact-pinned in package manifests and the lockfile.
- Automated dependency updates must not advance Effect RC versions independently.
- Imports from `effect/unstable/*` are isolated to Presenter, Runtime, or Adapter implementations.
- Domain types and Module Interfaces must not expose unstable Effect types.
- The migration to Effect v4 GA is performed as one reviewed dependency change.

## Presentation Seam

```text
React View
    -> Presenter / Effect Atom
    -> Deep Effect Module
    -> Browser or API Adapter Layer
```

Views render ViewModels and emit intents. They do not fetch data, decode wire payloads, or inspect transport failures. Presenters translate Module results into render states.

## Consequences

- New contributors encounter the widely used React/Vite view stack while application logic remains framework-independent.
- Search and reader state can survive refresh, Back/Forward navigation, bookmarking, and sharing.
- The project accepts controlled pre-release risk in exchange for avoiding a structural v3-to-v4 migration.
- Effect Atom APIs may still change before GA; exact pinning and narrow exposure constrain that risk.

## Rejected alternatives

- **Effect v3 stable**: lower immediate dependency risk, but creates likely migration work before or soon after v0.1.
- **React state plus TanStack Query**: duplicates Effect's ownership of asynchronous and remote state.
- **Framework-owned full-stack rendering**: adds server-rendering and server-framework concerns that the authenticated v0.1 application does not need.
- **Hand-written URL state**: repeats parsing, validation, and history behavior already handled by a focused Router Module.
