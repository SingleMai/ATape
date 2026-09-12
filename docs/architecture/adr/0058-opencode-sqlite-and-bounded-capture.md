# ADR-0058: OpenCode SQLite acquisition and bounded pending capture

- Status: Accepted direction; detailed contract in ADR-0059, first-release scope in ADR-0076
- Date: 2026-09-10
- The detailed capture/publication direction is selected in [ADR-0059](0059-opencode-publication-and-recovery.md). [ADR-0076](0076-source-collection-release-admission.md) fixes the supported first-release scope; the [OpenCode guide](../../adapters/opencode.md) records implementation and acceptance evidence.
- Decision: [OpenCode acquisition and support contract](https://github.com/SingleMai/ATape/issues/112)

OpenCode history is mutable: after Canonical or part of Raw is accepted, the
source can change before the Collector commits its cursor. Reading the latest
SQLite rows, exporting again, or requesting the SDK cannot reproduce vanished
content. The user accepted read-only local SQLite acquisition and bounded local
pending content for recovery, rather than relying exclusively on re-reading an
unchanged source.

## Decision

The OpenCode First-party Adapter reads local SQLite history through the existing
Host-owned bounded pull Interface. Initial discovery imports existing history;
subsequent collection discovers additions and revisions. The existing Collector
owns scheduling, redaction, delivery, retries and checkpoints. Provider schema,
source relationships, stable text encoding and Canonical projection remain in
the Adapter Implementation. SQLite lifetime and failures enter through scoped
Effect workflows; Presentation does not orchestrate capture.

The first implementation does not require an OpenCode plugin or a separately
running OpenCode Server. Official `opencode export` is a comparison source for
controlled prototype fixtures, not an automatic production fallback. A fallback
that changes representation or observation time cannot satisfy an existing
pending delivery identity merely because it names the same source Session.

Permit the minimum bounded content needed to resume an unfinished OpenCode
capture after a process restart. This is a deliberate exception to the
metadata-only/no-payload-spool constraints in ADR-0009, the planned designs in
ADR-0025, ADR-0026 and ADR-0027, and the outbox deferral in ADR-0053. It does not
enable content queues for existing Adapters or implement those deferred
protocols. Pending capture is a recovery
asset, not a second local history archive or a periodic backup of the source DB.
ADR-0053's prohibition on conversation payloads inside cursors remains in force;
pending content requires separate storage and an explicit lifetime Interface.

The detailed Interface must preserve these constraints:

- Fix the selected observation, identities, transformation version and delivery
  boundaries durably before remote effects that depend on them. Recovery must
  replay that observation, not bind newer source bytes to an old delivery unit.
- Canonical pending content and Raw pending content have separate obligations.
  Under ADR-0056, disabled Raw must not cause extra archival reads, retained Raw
  payloads, backlog or fabricated receipts. Reading what Canonical projection
  needs remains valid. Canonical pending storage must not become a hidden Raw
  backfill source; prefer the minimum projected, redacted delivery representation.
- Limit per-unit and total pending storage, apply backpressure at capacity, and
  release content after its relevant obligations are complete. Disk exhaustion,
  corruption or expiry must not silently discard an unacknowledged obligation or
  turn it into success. Policy changes require explicit obligation handling.
- Keep source modification distinct from replay: later message/part changes may
  produce a new revision, while previously fixed pending delivery remains stable.
  A completed message ID is not a permanent exclusion from future discovery.
- The Collector owns pending-delivery lifetime and confirmation semantics. The
  concrete storage Interface, crash-atomic installation, locking, permissions,
  redaction boundary, quota values and cleanup protocol must be designed and
  verified before production code relies on this exception.

Compatibility is evidence-based. Probe the actual source shape and supported
capabilities, rather than treating a DB path or a version string as proof of
support. Unknown or unreadable sources must be distinguishable from empty
history. Exact supported versions, legacy JSON coverage and platform claims are
release-scope decisions backed by controlled native fixtures; this ADR declares
no already-tested version range and does not authorize source migration.

## Alternatives and consequences

Entire and AgentLogs demonstrate plugin-triggered official export, while Confab
and CASS demonstrate direct SQLite acquisition. Export delegates storage parsing
to the provider, but adds executable, timeout and full-output handling; SQLite
offers local discovery and query control at the cost of schema maintenance.
The latter fits the current local-history scope and existing Collector. These
comparisons do not prove cross-restart deterministic delivery for ATape.

Metadata pins and digests without content avoid local storage growth, but cannot
recover content removed from the source. A long read transaction stabilizes a
live connection, not a process restart. Bounded pending content accepts storage,
privacy and cleanup responsibilities to make recovery practical. Copying the
whole database each cycle would exceed this decision's minimum-content scope.

This records the accepted route and recovery direction, not final Session/Thread
mapping, Raw generations, publication semantics or a finished implementation.
Those contracts and native crash/replay evidence remain prerequisites in the
[OpenCode decision map](https://github.com/SingleMai/ATape/issues/108).
The [product comparison](https://github.com/SingleMai/ATape/blob/dc69b2d8ff1c8264bbb7cc7fd3849d596f152774/docs/research/opencode-mature-products.md)
contains the fixed upstream sources, rejected shortcuts and regression scenarios.
