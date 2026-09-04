# Codebase Design: Deep Modules

ATape uses Deep Modules as its shared code-design doctrine. The goal is to concentrate behavior and knowledge behind Interfaces that callers can understand quickly and tests can exercise without reaching into the Implementation.

## Vocabulary

Use these terms consistently in architecture discussions and reviews:

- **Module**: any unit that presents an Interface and contains an Implementation. Its size may range from a function to a package or a vertical product slice.
- **Interface**: everything callers must know to use a Module correctly, including types, invariants, call ordering, failure modes, configuration, and performance characteristics.
- **Implementation**: behavior hidden inside a Module.
- **Seam**: the location where behavior can be replaced without editing its callers.
- **Adapter**: a concrete implementation installed at a Seam.
- **Depth**: the amount of useful behavior exposed through a small, coherent Interface.
- **Leverage**: the capability callers gain without learning the hidden complexity.
- **Locality**: the concentration of change, debugging, and verification inside one Module.

The term `Effect.Service` may appear in TypeScript code because it is a framework primitive. In architectural prose it represents an Interface at a Seam; it is not a reason to call every Module a service.

## Rules

### Prefer depth

A useful Module hides decisions, sequencing, retries, validation, state transitions, or compatibility behavior. A wrapper that merely renames another call or forwards all of its parameters is shallow.

Use the deletion test: imagine removing the Module. A deep Module causes its hidden complexity to spread back into several callers. A shallow Module mostly removes indirection.

### Keep one coherent Interface

A Module presents one conceptual Interface even if a language expresses it through several functions or types. Reduce the number of entry points, parameters, ordering constraints, and exposed implementation concepts.

Do not expose private collaborators so that tests can replace them. Callers and tests use the same Interface.

### Place only real Seams

An Interface keyword alone does not create a useful Seam. Introduce a replaceable Seam when behavior genuinely varies, a dependency crosses a deployment or ownership line, or production and test require justified Adapters.

Do not create a Repository Interface for every database table. PostgreSQL is local-substitutable for tests, so persistence can often remain private to a deep Module and be tested against an ephemeral real database.

### Classify dependencies

Before deciding on a Seam, classify the dependency:

1. **In-process**: pure calculation or memory-only state. Keep it private and test through the Module.
2. **Local-substitutable**: PostgreSQL, filesystem, or another dependency that can run locally. Prefer a real local test instance and keep its Seam private.
3. **Remote but owned**: another ATape deployment unit. Define a narrow port at the Seam and provide transport and in-memory Adapters.
4. **True external**: a third-party provider. Inject a narrow port and use a controlled test Adapter.

### Replace instead of layering tests

Behavior tests target the Module Interface and assert observable outcomes. When a deep Module replaces shallow Modules, replace their implementation-coupled tests instead of retaining every old layer of tests.

Tests should normally survive a private refactor. If a test must change despite identical externally observable behavior, it is probably testing past the Interface.

## ATape examples

Good candidates for deep Modules include:

- A Canonical ingestion Module that hides validation, identity resolution, idempotency, projection, transaction handling, and checkpoint advancement behind one batch operation.
- A Raw archive Module that hides chunk creation, staging, checksum verification, commit, and deduplication.
- A conversation reader that reconstructs Session and Thread order without exposing storage layout.
- A project search Module that hides index choice, filters, pagination, and precise Event positioning.

Avoid splitting those behaviors into chains of `Controller -> Service -> Manager -> Repository` objects whose Interfaces simply repeat one another.

## Designing consequential Interfaces

For an Interface with broad or long-lived impact:

1. Write down constraints, dependency categories, invariants, errors, and expected callers.
2. Produce at least two materially different Interface designs. Use three or more when the trade-off is unclear.
3. Compare designs by Depth, Leverage, Locality, and Seam placement.
4. Select one design and record rejected alternatives in an ADR.

The first plausible design is a starting point, not evidence that the Interface is finished.
