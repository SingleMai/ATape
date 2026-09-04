# ADR-0003: Canonical Ingestion Batch Interface

- Status: Accepted
- Date: 2026-09-04

## Context

Collectors deliver incremental observations every 10–30 seconds and retry after network failure. A source Event may therefore arrive repeatedly, grow through append-style updates, arrive late, or be reprojected after an Adapter/schema correction. Normal conversation reads must still expose one current Canonical record per logical Event.

The Interface must preserve the already accepted ACP-centered storage profile and ATape's persistence gaps without combining Raw payloads, Canonical reads, or Search projection.

## Considered Interfaces

### Individual Event CRUD

Each Event is created or replaced through its own endpoint. This is superficially simple, but exposes transaction sequencing to Collectors, produces chatty uploads, and cannot atomically connect Session, Thread, and Event observations.

### Append-only observation log

Every observation is appended and readers fold all versions. This preserves history, but pushes identity, revision, and current-snapshot complexity into every reader and risks slowing the main conversation path.

### Idempotent Canonical batch

One `ApplyBatch` operation validates and atomically applies a bounded Session/Thread/Event observation set. This keeps retry, identity, ordering, projection revision, and current-snapshot rules behind one deep Interface.

## Decision

ATape uses the idempotent Canonical batch Interface.

- HTTP Adapter: `POST /api/v1/ingestion/canonical/batches`.
- Module Interface: `Ingestor.ApplyBatch(ctx, batch)`.
- Each batch is limited to 4 MiB, 100 Threads, and 500 Events.
- A source Session identity includes `project + user + collector installation + adapter family + native session/source session key`.
- `adapterVersion` is provenance and does not participate in Session identity.
- A Canonical Event identity includes its Session, Thread, and stable source Event key.
- Reusing `batchId` with identical content is a replay; different content is an idempotency conflict.
- Higher entity revisions replace the current snapshot; lower revisions are stale; equal revisions with different content conflict.
- Higher projection revisions replace the active projection while prior versions remain outside the ordinary read result.
- Thread display order uses `(sourceOrder, eventIndex)`. Timestamps and server `ingestSeq` do not define conversation order.
- Each Event carries Adapter/schema provenance, fidelity, order fidelity, and an opaque Raw reference. Raw payloads are never embedded in this Interface.
- The alpha Interface accepts only the shared event kinds `message`, `thought`, `tool_call`, `tool_result`, `artifact`, `spawn`, and `lifecycle`. Extension kinds remain closed until the protocol carries an explicit extension schema and version.
- Project Memory and Session Reader query only current Canonical snapshots. Search remains an independent derived read model.

The `atape.canonical.v1alpha1` HTTP representation is currently an internal alpha covering the reader's text projection. It is not yet the public Adapter SDK schema. Expanding semantic payloads must reuse pinned ACP ContentBlock/Message and the accepted AG-UI/A2A profiles rather than adding another ATape content taxonomy.

## Storage Adapters

The first slice used a concurrency-safe in-memory Canonical Store to prove the complete behavior locally. ADR-0004 adds the durable PostgreSQL Adapter and runs the same observable behavior contract against both implementations. The in-memory Adapter remains the zero-setup development default and is not durable across process restart.

## Consequences

- Collectors can use at-least-once delivery while the server provides exactly-once observable effect.
- Append-style message updates remain one Event in Project Memory and Session Reader.
- Late Events can return to their native Thread position.
- Main reads do not fold Raw observations or historical projections.
- A PostgreSQL implementation can replace storage details without changing the HTTP or application Interface.

## Rejected Alternatives

- **Individual Event CRUD**: exposes ordering and partial-commit complexity to every Collector.
- **Fold every observation on read**: couples ordinary conversation latency to observation history.
- **Raw and Canonical in one upload record**: violates the accepted physical and query-path separation.
