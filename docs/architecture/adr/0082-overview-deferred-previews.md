# ADR-0082: Overview facts and deferred previews

- Status: Accepted
- Date: 2026-09-13

## Context

Team Overview transfers message excerpts for both periods and every Session even
though only the current page needs previews. Publication head changes and deletion
must not mix statistics from one snapshot with previews from another.

## Alternatives and decision

1. Read facts, close the transaction, then issue a separate preview operation.
   This is a simple persistence Interface but loses snapshot consistency unless
   callers acquire and reconcile explicit version tokens.
2. Keep one Overview operation and accept a pure selection callback. The
   persistence Adapter loads body-free facts, calls the selector, validates at
   most 100 selected Event identities, loads their excerpts in the same snapshot,
   and returns the facts and excerpts together. The Team Overview Module owns
   aggregation, page selection and preview semantics.

Select option 2. The existing persistence Seam has PostgreSQL and memory Adapters;
no new Module or test-only Seam is introduced. This adds Depth to the existing
operation by hiding transaction lifetime and selected-part lookup. The callback
must not mutate the snapshot, perform I/O, or retain a transaction resource.
A nil selector requests facts only. Selection is limited to Events in those facts.
The HTTP Interface remains unchanged.

## Implementation and consequences

PostgreSQL retains one read-only repeatable-read transaction. Publication preview
lookup uses current-head membership to locate exact parts and entry indexes,
decoding each selected part once. It does not scan Raw or use Search. Memory
selection runs under the existing snapshot lock. Preview text remains bounded to
1,500 source characters and is formatted only for the returned page.

Previous-period aggregation produces metrics only. Metadata queries select the
fields actually needed, while existing Team-wide capacity and filter semantics
remain unchanged. Web dimension-table pagination is local and does not change
the remote Session page; Session pagination still invokes Overview.

This increment does not add a persistent statistics read model, SQL aggregation,
filter pushdown, cross-request caches or a separate HTTP pagination endpoint.
See the [current guide](../../team-overview.md) for verification and remaining scope.

[ADR-0083](0083-filtered-overview-and-session-pages.md) subsequently adds dimension
selection before fact limits and a Session-page HTTP Interface, retaining this
snapshot and deferred-preview decision.
