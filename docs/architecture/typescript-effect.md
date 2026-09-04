# TypeScript and Effect

This guide applies to every ATape TypeScript executable: Web, CLI, Collector Core, and Shared Adapter Host. Effect is the application runtime for side effects and workflows; it is not confined to HTTP fetching or database access.

## Separation of presentation and logic

Presentation owns input and output:

- Web views render ViewModels and emit user intents.
- CLI commands parse arguments, invoke a Module, and render structured results.
- Adapter Host entry points translate host messages into Module calls.

Presentation does not own retries, authorization decisions, persistence, synchronization, Canonical projection, or provider compatibility rules.

A Web view may keep ephemeral interaction state such as focus, a disclosure toggle, or an unfinished input. Remote data, workflows, and durable business state belong to Effect-backed Modules.

## Required Effect usage

- External I/O enters the application as an Effect. Promise-based SDKs are wrapped at the Adapter.
- Dependencies are declared as Effect requirements and provided by Layers at the Composition Root.
- Expected failures use typed error channels. Defects remain distinct from recoverable failures.
- Resource acquisition and release use scoped Effect constructs.
- Concurrency, retry, timeout, scheduling, and cancellation policies are visible in the owning Module.
- Effect Schema decodes untrusted API, configuration, Adapter, and persisted inputs before domain use.
- Logging, metrics, and tracing attach to Module operations rather than being reconstructed only at the outermost edge.
- `Effect.runPromise` or equivalent runtime execution occurs only at executable or presentation bindings.

Pure calculations remain ordinary pure TypeScript functions. Wrapping a deterministic transformation in Effect without a requirement, failure, resource, or asynchronous concern adds no Depth.

## Suggested layout

```text
apps/
  web/
    src/view/             # rendering only
    src/presenters/       # user intents and ViewModel bindings
    src/runtime/          # Browser Layers and runtime execution
  cli/
    src/commands/         # argument parsing and terminal rendering
    src/runtime/          # Node Layers and runtime execution
  adapter-host/
    src/presentation/     # host protocol translation
    src/runtime/

packages/
  ui/                     # semantic tokens, themes, and pure React primitives
  protocol/               # Canonical and wire Schemas
  domain/                 # pure shared types and rules
  application/            # deep Effect Modules
  platform-browser/       # Browser Adapters and Layers
  platform-node/          # Node Adapters and Layers
```

Feature-specific code may live together when that improves Locality. The directory names are not a mandate to split every operation into multiple pass-through files.

## Import rules

- `domain` imports neither Effect platform packages nor presentation frameworks.
- `ui` imports React for pure presentation only; it imports no domain, application, routing, or platform package.
- `application` may import core Effect and domain packages, but not Web views, CLI rendering, Browser implementations, or Node implementations.
- platform packages implement requirements declared by application Modules.
- views import ViewModel types and presenter bindings; they do not import transport clients or infrastructure Layers.
- only runtime entry points assemble the complete Layer graph.

## Style system boundary

The `@atape/ui` package is the Interface for reusable visual primitives and semantic `--atape-*` design tokens. Themes implement that token Interface; they do not override product selectors or own application state. Product-specific composition and responsive layout remain local to each presentation application.

Applications import the selected theme and foundation CSS once at their Composition Root. Views consume `@atape/ui` primitives and semantic tokens, never theme-specific hex values. A theme switch therefore replaces a token Adapter rather than changing product components.

These rules should become CI-enforced import constraints once the monorepo scaffold exists.

## ViewModel contract

Views consume explicit render states rather than inspecting Effect failures directly. A typical shape is:

```ts
type LoadableView<A> =
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Ready"; readonly value: A }
  | { readonly _tag: "Empty"; readonly guidance: string }
  | { readonly _tag: "Failed"; readonly message: string; readonly retryable: boolean }
```

The presenter maps domain results and typed failures into this Interface. Views decide appearance; presenters decide what state the user is in and which intents are legal.

## State ownership

Do not install a second general-purpose remote-state runtime beside Effect. A rendering-framework binding may subscribe to Effect-backed state, but React Query, Redux, Zustand, or equivalent libraries must not duplicate ownership of server and workflow state.

## Testing

- Test pure domain rules directly.
- Test a deep Effect Module by providing test Layers at its actual Interface.
- Test Adapters with contract or integration tests.
- Test views from ViewModels and emitted intents, without booting production infrastructure.
- Avoid tests that assert internal Effect combinator order when externally observable behavior is unchanged.

## Versioning

The selected Effect major version is fixed in [ADR-0001](adr/0001-web-runtime-and-view-stack.md) and the workspace lockfile. Do not mix v3 and v4 packages within one executable.
