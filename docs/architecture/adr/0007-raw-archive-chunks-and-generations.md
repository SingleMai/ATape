# ADR-0007: Raw Archive Chunks and Generations

- Status: Accepted
- Date: 2026-09-04

## Context

ATape preserves the source material behind a shared Canonical conversation so team members can inspect what an Adapter actually captured. Raw data is operational evidence, not a Canonical Event and not a Search document. It may be large, may arrive as an append-only source, and must remain available after the originating Harness deletes its local Session.

Clients redact configured secrets before upload. The server must reject unredacted declarations, bound every request and read, verify bytes exactly, and make retries idempotent without loading a complete source file into memory.

Raw bytes and their metadata have different operational characteristics. PostgreSQL is appropriate for transactional identity and append state; a blob-oriented store is appropriate for immutable content. The first deployable blob Adapter can be a filesystem, but the Module must leave a real Seam for object storage.

## Considered Designs

### Store Raw bytes with Canonical records in PostgreSQL

This makes one database sufficient, but large payloads bloat backups, indexes, and vacuum work. It also invites ordinary conversation and Search queries to cross the Raw boundary.

### Maintain one mutable append file per Raw object

Appending in place resembles the provider source and is easy to inspect. However, retries, concurrent uploads, truncation, partial writes, and crash recovery all mutate the same object. A bad write can corrupt the only retained copy.

### Store immutable chunks with transactional manifests and generations

The byte store accepts content-addressed immutable chunks. PostgreSQL or an in-memory development Adapter commits object identity, generation state, offsets, finalization, and idempotency receipts. A source rewrite starts a new generation while previous generations remain readable.

## Decision

ATape uses a deep `rawarchive.Archive` Module backed by two consumer-owned Seams:

- `ManifestStore` owns Raw object identity, ordered generations, append offsets, finalization, and exact chunk replay semantics.
- `ChunkStore` owns immutable bytes by an opaque storage key. Filesystem, in-memory, and future object-storage Adapters implement this real production variance.
- `Archive.Append`, `Archive.OpenSession`, and `Archive.Read` are the public operations. HTTP handlers only translate requests and typed failures.

The alpha upload protocol is `atape.raw.v1alpha1`. Each upload declares a stable `chunkId` and `objectId`, the Canonical `projectId` and `sessionId`, source and Adapter metadata, a generation, byte offset, finalization flag, client-redaction acknowledgement, Base64 content, and SHA-256 digest.

- Decoded chunks are at most 256 KiB. HTTP request bodies are at most 512 KiB.
- The server decodes one bounded chunk and verifies its SHA-256 before writing any state.
- A new object starts at generation 1, offset 0. Appends must exactly match the current byte size.
- Replaying an identical `chunkId` is successful and has no additional observable effect. Reusing it with different metadata or content is a conflict.
- A finalized generation rejects more appends. A source truncation or rewrite starts exactly the next generation at offset 0; older and skipped generations are conflicts.
- Chunks are written before manifest commit. A failed manifest transaction may leave an unreachable immutable blob; retry adopts the same key. Orphan collection is an independent future maintenance concern.
- Raw reads expose an object manifest separately from a cursor-based content endpoint. Each page is bounded by chunk count and therefore memory.
- Raw payloads never enter Canonical tables, ordinary Session responses, Search tables, or Search queries.
- Source deletion does not delete captured Raw data. v0.1 exposes no provider-synchronized delete operation.

PostgreSQL stores only Raw manifests and chunk metadata in separate `raw_*` tables. A configured `ATAPE_RAW_DIRECTORY` provides the production filesystem Chunk Store. PostgreSQL deployments without that explicit directory keep Canonical features available but return a typed unavailable failure for Raw operations instead of silently using ephemeral storage. Local in-memory development uses an in-memory Raw Adapter and representative redacted demo data.

## Consequences

- Canonical conversation and Search latency do not scale with Raw payload size.
- Append retries and process restarts retain exactly one logical chunk record.
- Rewritten provider files keep historical generations instead of overwriting evidence.
- Raw content is fetched only after an explicit user action and can later move from filesystem to S3-compatible storage without changing the Archive or Web Interfaces.
- Operators remain responsible for database and blob capacity. ATape enforces per-operation memory bounds, not a hidden retention policy.
- Filesystem deployments that run multiple server replicas must mount shared storage or replace the Chunk Store Adapter.

## Rejected Alternatives

- **Raw in Canonical or Search storage**: couples independent workloads and weakens the stable Canonical protocol.
- **Mutable append files**: make retries and crash recovery destructive and difficult to reason about.
- **Mandatory remote object storage in v0.1**: adds an operational dependency before deployment scale requires it.
- **Automatic deletion when the provider deletes a Session**: contradicts ATape's role as retained team memory.
