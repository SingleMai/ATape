# ADR-0022: Canonical-priority collection and larger Raw chunks

- Status: Accepted
- Date: 2026-09-07
- Amends: [ADR-0007](0007-raw-archive-chunks-and-generations.md), [ADR-0009](0009-pull-adapter-runtime-and-checkpointed-collector.md), [ADR-0017](0017-http-interface-and-route-security.md)

## Context

The first dogfood backfill contains hundreds of Codex Sessions and several
GiB of Raw rollout data. The original Collector coupled each Canonical page to
up to 16 MiB of Raw progress, then divided that Raw segment into 256 KiB HTTP
requests. A single Project/Adapter job sent those requests serially so exact
append offsets and receipts remained simple.

That shape preserved correctness but gave Raw archival control over product
visibility. One 67 MiB Session required hundreds of request, filesystem sync,
and PostgreSQL transaction round trips before the Adapter selected the next
Session. The Collector's configured concurrency did not help because it
applies across Project/Adapter jobs, not within one ordered Raw object.

The existing five MiB reverse-proxy ceiling can safely carry more than 256 KiB
without making request memory unbounded. Canonical data, Raw progress, and the
Search read model must remain separate concerns.

## Considered designs

### Durable Host-side Raw outbox

The Host could commit Canonical data and persist pending Raw payloads to a new
local outbox before advancing the Adapter cursor. This gives the Host a generic
background uploader, but duplicates large provider bytes locally and adds a
second durable state machine with cleanup, encryption, capacity, and crash
recovery policy.

### Batched 256 KiB chunks

A new endpoint could accept several existing chunks in one request. Chunk
identity remains unchanged, but partial batch receipts and atomicity across the
filesystem Chunk Store and PostgreSQL manifest make the Archive Interface and
retry contract substantially wider.

### Adapter-owned Canonical and Raw phases with larger bounded chunks

The Adapter cursor can identify whether its active Session is projecting
Canonical data or filling Raw progress. It advances the Canonical watermark
after Canonical completion, then uses the existing Host-provided `rawProgress`
to find and resume Raw gaps. Raw transport chunks can grow to three MiB: Base64
expansion is four MiB and leaves metadata headroom beneath the five MiB HTTP
and proxy limit.

## Decision

ATape selects Adapter-owned Canonical and Raw phases plus three MiB transport
chunks.

- Changed or unseen Sessions are always selected for a `canonical` phase
  before any Session is selected only for a `raw` phase.
- Completing a Canonical phase advances the Canonical watermark even when that
  Session still has Raw gaps. The Session and its conversation can therefore
  become visible without waiting for historical Raw archival.
- Once Canonical work is caught up, the Adapter scans the existing
  `rawProgress` Interface for the oldest incomplete source and resumes it in a
  `raw` phase. A Raw observation carries no Canonical Events, but retains the
  same Session and Thread identity needed by the existing ingestion Interface.
- Cursor v5 records the active phase. Cursor v4 migrates its active work to the
  Canonical phase while preserving offsets and watermark; versions 1 through 3
  retain their existing Canonical replay migration.
- The Host divides redacted Adapter segments into UTF-8-safe transport chunks
  of at most three MiB. The Raw endpoint accepts a complete JSON request of at
  most five MiB. Immutable chunk identity, SHA-256 verification, exact append
  offsets, finalization, replay, and generation semantics do not change.
- One completed phase advertises one more page. The following no-work page
  closes the cycle, allowing the Host to drain consecutive Canonical or Raw
  work without adding a fixed scheduling interval between Sessions.

## Consequences

- Session visibility now scales with Canonical projection work rather than Raw
  archive size. On initial backfill, up to the page budget of Sessions can
  appear in one Collector cycle.
- A full 16 MiB Raw observation normally needs six HTTP requests instead of
  sixty-four, reducing network, authorization, filesystem sync, and database
  transaction round trips by roughly an order of magnitude.
- Raw archival is eventually consistent with Canonical ingestion. Continuous
  Canonical changes can delay Raw catch-up because user-visible conversation
  data has explicit priority.
- The Collector and server must be upgraded together before the Collector
  emits chunks larger than the old server's accepted subset.
- Memory remains bounded by one three MiB decoded chunk, its Base64 wire form,
  and the existing five MiB request ceiling. The reverse proxy limit does not
  change.

## Rejected alternatives

- **Host-side Raw outbox**: too much new durable local machinery for a backlog
  already reproducible from the provider archive.
- **Batched append endpoint**: improves round trips but widens the Archive
  atomicity and replay Interface more than the selected bounded-size change.
- **Parallel appends to one Raw object**: conflicts with exact offset ordering;
  cross-object parallelism remains a possible later optimization.
- **Dropping Raw during backfill**: improves speed by weakening the retained
  evidence guarantee and is not an acceptable implicit policy.
