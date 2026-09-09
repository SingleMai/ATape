# ADR-0049: Commit empty pages that advance collection

Status: Accepted

## Decision

The Collector Module accepts an empty Adapter page with `hasMore: true` when its
nonempty replacement cursor differs from the requested cursor. This supports
finishing an already emitted Canonical phase or skipping a source that disappeared
since selection, without fabricating a Canonical observation. The existing
Implementation commits that cursor and continues within the existing per-cycle
page bound. It preserves acknowledged Raw progress and performs no upload for
the empty page. Failed uploads on later pages do not acknowledge those pages.

The Interface previously required an observation whenever `hasMore` was true.
Codex already emits progress-only transitions; rejecting those transitions traps
every retry at the same checkpoint and prevents subsequent history from uploading.
Null, empty, oversized and unchanged continuation cursors remain invalid.
Diagnostic-only pages without traversal progress still terminate collection.

## Alternatives and consequences

Requiring Codex to skip empty phases inside one call keeps the former Interface
but hides traversal from the Host's page budget and duplicates continuation policy
in Adapters. Fabricating empty Canonical observations creates unnecessary server
writes. Accepting bounded cursor progress gives both Adapters Leverage through
one existing Interface, preserves Locality in the Collector, and adds no Seam.

Regression tests exercise the public collection Interface: empty transition then
publication, stalled cursors, bounded empty-page runs, and resumption after a
later upload failure. Existing Adapters remain valid; Adapters using empty
continuations require an updated CLI. This does not change capture attribution,
Canonical or Raw contracts, or reset existing checkpoints.
