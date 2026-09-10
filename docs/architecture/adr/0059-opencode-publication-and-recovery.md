# ADR-0059: OpenCode publication and recovery contract

- Status: Accepted design; Implementation and native acceptance pending
- Date: 2026-09-10
- Decision: [OpenCode identity, Raw and mutable-history contract](https://github.com/SingleMai/ATape/issues/113)

The user accepted delivering common atomic Canonical publication with the first
OpenCode Adapter. A rewind followed by a new answer must replace the selected
conversation path without mixing old and new members in the timeline or Search.
Use ADR-0025's target/head model with ADR-0058's bounded pending content, rather
than limiting the first Adapter to histories that never withdraw Events.

The detailed engineering contract is recorded in
[OpenCode capture and publication](../opencode-capture-publication.md).
Its first publication capability uses explicit replacement targets; patch
optimization and migration of existing Codex/Claude Sessions are not prerequisites.
This scopes the initial implementation of ADR-0025; it does not claim the existing
ingestion API already implements publication.

## Decision

- OpenCode grouping, Active Path selection and source fidelity remain in the
  client Adapter. The Server receives provider-neutral Session metadata, Thread
  topology, Event/usage membership and immutable content references.
- The Collector reserves identity/origin and an idempotent Begin request before
  capture. Begin binds the base head and writer fence. The Adapter then reads a
  controlled SQLite view; the Host validates, redacts and seals the complete
  promised target as bounded final delivery units before content transmission.
  A source transaction does not wait on network delivery.
- Prepared content is owned by the Collector, with a transactional SQLite
  metadata and pending-content Adapter. Content stays outside cursors. Store
  bounded units, not a whole serialized Session BLOB or a copy of the source DB;
  access and cleanup are paginated and scope-aware. The same transaction binds
  the sealed manifest, identities, expected checkpoint and reserved progress.
- Numbered parts, seal/validation and activation are independently recoverable.
  First activation atomically changes the current head, records its receipt and
  enqueues Search work after validating authorization, lease, fence and base.
  Replaying a successful activation returns its original receipt and never
  moves the current head backward.
- Readers and Search eligibility use the same activated head. New Search
  indexing may finish later; old membership/descriptors are filtered immediately.
  First publication is invisible until activation; a failed update retains the
  last successful view. Old-head pagination asks for refresh instead of mixing
  pages. Temporary disconnection does not make an old view current by assertion.
- Canonical activation and Raw delivery are distinct obligations. A subsequent
  Canonical head does not invalidate earlier Raw recovery. Raw writes require
  their own current authority and fence, a genuinely activated capture and an
  unchanged stable Session lifecycle, not that capture's head still being latest.
- Raw is an observation log of the row states actually read, stored in bounded,
  immutable objects with one generation per object. Later row changes append
  new observations; object references never silently resolve to newer versions.
  A prepared object can still be pending upload when Canonical becomes visible.
- A Canonical version captured while Raw is disabled keeps an unavailable
  reference. Turning Raw on can archive a new observation of still-available
  source rows independently; it does not mutate that old Canonical version or
  claim that a matching row ID proves identical old Raw. This clarifies the
  mutable-source backfill boundary of ADR-0056 without changing policy precedence.
- Policy cancellation terminates an unfinished Raw obligation explicitly. It
  does not create an ACK or advance Raw offsets. Preserve genuine receipts and
  archive gaps, and reclaim only content no longer needed by any live obligation.

## Identity and scope

A proven native root maps to one Captured Session; native descendants map to its
Captured Threads. Native parent evidence determines ownership; task metadata
only links a call to a child already proven to belong to that family. Forks are
self-contained Sessions, compaction stays in the same Thread, and historical
branches are not subagent Threads. Missing Origin or root evidence produces a
diagnostic, not guessed attribution.

Stable source IDs and fixed projection slots identify Events; hashes detect
change but are not ordered revision numbers. Reserve source-version mappings
transactionally and reuse them on retry. Target heads describe publications,
separately from source IDs and source occurrence time. The new head-scoped
topology follows ADR-0025; legacy immutable ownership is not silently bypassed.

## Bounds and failure behavior

The capture Interface requires explicit per-record, per-unit, per-target,
total-pending, concurrency and time budgets. Reserve capacity before sealing;
exhaustion applies backpressure and preserves the last published view. Unknown
formats and oversized values are explicit fidelity/source failures, never
silent Raw truncation or a partially delivered replacement presented as complete.
Initial numeric defaults and supported version/platform claims are validated
release parameters, not evidence established by this ADR.

An unsealed capture that loses its SQLite view is discarded and recaptured under
a valid new attempt. A sealed attempt resumes only while the Server recognizes
its original identity/authority. Stale fences require a new capture, not a new
label on old content. Expired or unknown receipts require reconciliation;
absence of a receipt is not proof that activation failed.

## Alternatives and consequences

Adapter-owned source staging would also retain a view, but adds a provider
storage format and still needs to freeze projection, redaction and wire encoding.
Collector-owned final units keep that distributed behavior in one deep Module.
The OpenCode SQLite Adapter is a real source Seam; the local journal and remote
publication services are real persistence/transport Seams, not mocking-only
Interfaces. Presentation only translates input and displays state.

The previous alternative—pause histories when rewind cannot be expressed—was
not selected. Atomic publication expands the first increment to Collector,
Server persistence/read paths and Search eligibility. It must pass those
interfaces' real integration and recovery checks; the existing scratch SQLite
models demonstrate selected failure behavior, not a finished protocol.

This ADR schedules the common publication/recovery work for OpenCode. It does
not implement arbitrary-size byte framing, opaque multi-generation Raw anchors,
remote OpenCode Server capture, package publication or deployment.
