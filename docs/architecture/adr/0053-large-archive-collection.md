# ADR-0053: Bounded collection of large archives

[ADR-0058](0058-opencode-sqlite-and-bounded-capture.md) scopes an exception to the
payload-outbox deferral for OpenCode pending capture. Its detailed contract and
Implementation remain pending; the prohibition on content inside cursors below
continues to apply.

Status: Accepted

## Decision

Collection is a resumable workflow, with independent Canonical and Raw progress.
The Adapter Interface keeps opaque, acknowledged cursors; provider file size is
not a collection limit. Each read, record, observation, transport chunk and cursor
still has an explicit bound. A record that cannot be projected is diagnosed by
source without acknowledging its bytes or blocking unrelated sources.

Claude moves from whole-file snapshots to record pagination and stable appendable
Raw objects. Legacy checkpoints validate their acknowledged prefix before a
one-time idempotent projection upgrade. Prefix validation uses streaming hashing;
unchanged source snapshots may reuse validated parser state within a runtime.
Strict detection of arbitrary edits to a captured prefix requires reading those
bytes when the source changes; this integrity cost is not advertised as O(delta).
Canonical parsing and publication resume at the acknowledged record position.

Codex keeps completed per-source offsets and rotates bounded Session work so
newly discovered conversations and Raw backlog receive service while a large
Session is incomplete. A filesystem discovery cache contains paths and source
metadata, never durable authorization decisions. Periodic complete discovery is
the recovery path for new files and moves. Short-Session boundaries reuse discovery
for at most four pages. Every selected Session is refreshed and reauthorized before
reading; title-index changes, missing sources and an apparently idle inventory force
a complete scan. This supersedes ADR-0052's per-Session full-scan boundary.

The Host permits a bounded compressed metadata cursor larger than the original
16 KiB ceiling; conversation payloads do not enter cursors. Transport can overlap
independent Raw objects while retaining exact ordering within each object, and
serializes durable receipt commits. Retry scheduling and local progress reporting
remain owned by the Collector Module, not Presentation. Ingestion requests have
a bounded 60-second deadline for multi-MiB uploads over slower links; cancellation
still propagates immediately, and control requests keep their 10-second deadline.
Every fourth Canonical scheduling turn serves the oldest eligible work, so two
busy recent Sessions cannot starve older history indefinitely.

## Alternatives

Raising whole-file limits preserves repeated full parsing and memory growth, so
it is rejected. A durable payload outbox would duplicate provider data and add a
second recovery and retention workflow; it is deferred. Parallel appends to one
Raw object violate its offset Interface and are rejected. Long-lived authorization
caches are rejected; batching/discovery reuse must retain current Host checks.

## Verification

Exercise real database migration plus maximum-size Raw append and replay; large
Claude pagination and append; Codex fairness and append; failed-source repair;
transport failure and cancellation; and status that distinguishes progress from
full completion. Provider format incompatibilities remain explicit diagnostics.
