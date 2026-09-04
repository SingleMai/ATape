# ADR-0005: Canonical Search Read Model

- Status: Accepted
- Date: 2026-09-04

## Context

ATape must replace asking a teammate or exporting a complete conversation with project-scoped keyword retrieval that opens the exact Canonical Event in its Session and Thread. Search is derived from Canonical data, includes child Threads, and must never join Raw payloads on its query path.

Canonical ingestion has exactly-once observable effect, while Search may be eventually consistent. A failed or slow index must not extend the synchronous ingestion transaction or invalidate an already accepted Canonical batch. The initial implementation uses PostgreSQL, but the Module Interface must leave room for a sharded or remote search engine.

## Considered Designs

### Query Canonical tables directly

Search current Event text with `LIKE` or full-text expressions over the Canonical tables. This has minimal write complexity, but search-specific indexes, ranking, snippets, and pagination would directly shape the Canonical storage schema and compete with conversation reads.

### Project synchronously during ingestion

Update the Search table inside the Canonical batch transaction. This gives immediate visibility, but makes index latency and availability part of the ingestion contract and prevents independent migration to a remote index.

### Durable change feed and asynchronous projector

Append a generic Event projection change in the Canonical transaction. A bounded worker leases changes, builds current Canonical projection documents, upserts the independent Search index, and acknowledges the changes only after the index commit.

## Decision

ATape uses a durable Canonical change feed and asynchronous Search projector.

- Canonical persistence appends one change for each inserted or updated active Event in the same transaction as the batch receipt.
- `projectsearch.ChangeSource` leases current Canonical Event projection documents and acknowledges processed change IDs.
- `projectsearch.ProjectionIndex` idempotently upserts documents by Event ID and monotonic `ingestSeq`.
- `projectsearch.QueryIndex` performs project-scoped keyword lookup against only the Search read model.
- `projectsearch.Projector` owns batching, lease duration, polling, cancellation, and acknowledgement ordering behind `ProjectOnce` and `Run`.
- One projector instance leases at most 100 changes for 30 seconds and polls at one-second intervals. Expired leases are retryable by another process.
- PostgreSQL stores `canonical_projection_changes`, `project_search_documents`, and per-project Search checkpoints in separate tables. Normal conversation reads never touch them.
- The first query Adapter combines the built-in `simple` text-search configuration with literal substring matching. This covers code identifiers, phrases, and unsegmented text while leaving ranking/index choice private.
- Search returns an opaque cursor, an `indexedThrough` watermark, and precise `sessionId`, `threadId`, `threadPath`, and `eventId` anchors.
- The v0.1 API accepts one non-empty query up to 200 UTF-8 bytes and returns 1–50 results per page, defaulting to 20.
- PostgreSQL and in-memory development Adapters implement the same Search Interfaces. The in-memory Adapter is not a production index.

Search visibility is intentionally eventual. A successful Canonical ingestion response does not promise that the Event is immediately searchable.

## Consequences

- Search indexing failures cannot roll back accepted Canonical history.
- Replaying a Canonical batch does not emit duplicate changes; repeated projection attempts remain idempotent.
- Search can later move to a remote or sharded engine without changing HTTP handlers, Web Gateways, or Canonical ingestion.
- Search documents duplicate the small subset of Canonical fields needed for retrieval and navigation.
- The UI can communicate the Search watermark and preserve queries in the URL while opening exact Events.

## Rejected Alternatives

- **Direct Canonical scans**: violate the independent read-model boundary and make future index changes invasive.
- **Synchronous index writes**: couple ingestion correctness and latency to Search availability.
- **Raw indexing**: searches provider storage details instead of the stable Canonical conversation and risks exposing redacted source material.
- **Remote search engine in v0.1**: adds an operational dependency before ranking and scale requirements are evidenced.
