# ADR-0004: PostgreSQL Canonical Persistence Adapter

- Status: Accepted
- Date: 2026-09-04

## Context

Canonical ingestion now proves stable identity, idempotent retries, append-style Event updates, active projections, and read reconstruction with an in-memory Adapter. That Adapter loses captured team history on process restart and serializes all work through one process-local lock.

PostgreSQL is a local-substitutable dependency selected by the Go architecture guide. The persistence boundary must keep transaction and schema knowledge out of the ingestion and conversation Modules, while preserving the separation between Canonical current data, Canonical projection history, Raw storage, and the Search read model.

## Considered Interfaces

### One shared broad Store Interface

Expose ingestion writes, project reads, conversation reads, migration, health, and connection lifetime through one `CanonicalStore` Interface. This makes Composition Root wiring simple but forces each consumer to depend on operations and lifecycle concepts it does not use.

### Consumer-owned capability Interfaces

Let ingestion own a one-operation `BatchStore` Interface and conversation own a two-operation `SnapshotStore` Interface. PostgreSQL and the development in-memory Adapter implement both. Database connection and migration lifetime remain outside those consumer Interfaces.

### Persist batch JSON and fold it on reads

Store each normalized batch as an immutable JSON document and rebuild current Sessions, Threads, and Events when queried. This minimizes initial SQL but makes ordinary reads dependent on all observation history and repeats identity/revision logic in the read path.

## Decision

ATape uses consumer-owned capability Interfaces with one PostgreSQL Adapter.

- `ingestion.BatchStore` atomically applies one normalized Canonical batch.
- `conversation.SnapshotStore` reads Project Memory and one Session/Thread from active Canonical rows.
- PostgreSQL schema and generated queries are private to `internal/adapters/postgres`.
- `pgx/v5` provides the connection pool and transaction implementation; `sqlc` generates typed query code.
- One database transaction owns project/session/thread validation, Event revision decisions, active snapshot updates, Event-version append, project capture advancement, and batch receipt creation.
- Transaction-scoped advisory locks serialize a batch identity and a Session source identity. They prevent concurrent retries or concurrent append observations from bypassing revision checks.
- Current Events and Event projection versions occupy separate tables. Normal conversation queries touch only the current table.
- Raw references remain opaque text. Raw payloads and Search documents are not stored in this schema.
- Migrations are embedded, versioned, applied under a database advisory lock, and complete before the HTTP listener starts.
- `ATAPE_DATABASE_URL` selects PostgreSQL. Per [ADR-0010](0010-compose-self-hosting-topology.md), the seeded in-memory development Adapter is available without it only when `ATAPE_DEMO_MODE=true` is explicit.

The initial migration is forward-only. A failed migration leaves its transaction unapplied and prevents server startup. Destructive rollback is an operator action, not an automatic process-start behavior.

## Consequences

- Server restarts retain accepted Canonical batches and their idempotency receipts.
- Different server replicas share one exactly-once observable state.
- Ingestion and conversation callers do not know table names, SQL rows, pool types, or migration ordering.
- Integration tests can run the same externally observable ingestion/reader behavior against a real ephemeral PostgreSQL instance.
- The in-memory Adapter remains useful for fast unit tests and demo data, but it is no longer the intended durable deployment configuration.

## Rejected Alternatives

- **Broad shared Store Interface**: weakens Locality and exposes unrelated operations to each Module.
- **JSON observation folding**: couples normal reader latency and correctness to historical observations.
- **Per-table Repository Interfaces**: creates shallow pass-through layers and moves transaction ownership into callers.
- **Mock PostgreSQL behavior**: cannot verify constraints, locking, generated queries, or transaction atomicity.
