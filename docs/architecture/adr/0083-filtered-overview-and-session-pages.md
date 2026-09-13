# ADR-0083: Filtered Overview facts and independent Session pages

- Status: Accepted
- Date: 2026-09-13

## Context

Overview reads both periods for the whole Team before applying dimension filters.
Session pagination additionally constructs chart and dimension groups that its
view does not display. A filtered request cannot recover from an unrelated
Project exceeding the fact cap.

## Alternatives and decision

1. Cache complete dashboards and serve subsequent pages from cached results.
   This requires bounded cache lifetime plus invalidation for capture, head
   replacement, deletion and revoked membership. It also retains entire results.
2. Push dimension selection into the existing persistence Seam and add a Session
   page operation returning its own consistent summary, options and page. Keep
   authoritative reads and current membership enforcement on every request.

Select option 2. The Team Overview Module retains aggregation semantics; the
PostgreSQL Adapter scopes native rows and publication parts before decoding.
Project, member and Agent select Session identities. Model selection filters
usage and admits message activity only in a period containing matching usage
for that Session. Child usage remains attributed to its Session. Both periods
retain independent model eligibility.

## Interface and behavior

`GET /api/v1/teams/{teamId}/overview/sessions` accepts the same filters and paging
as Overview. It returns current and comparison metrics, filter options, unknown
time disclosure and the requested Session page, with one snapshot timestamp.
It omits chart and dimension tables. This avoids merging fresh Session rows with
stale visible summary metrics. The original Overview Interface remains supported.
The Web reuses Overview for the first page and uses the Session operation for
subsequent Session pages; local dimension pagination remains request-free.
An older Server's missing route (HTTP 404) falls back to the existing authorized
Overview operation in the application Module. Other failures do not fall back.
If Team access was revoked, the fallback also fails authorization and the Web
discards the previous snapshot.

Fact capacity is now applied after dimension selection, before paging. An
unrelated Project no longer makes an otherwise bounded selection fail. Directory
limits remain Team-wide. Filter choices retain all retained Team Agents and all
models observed in the comparison window, independent of active dimensions.
Unknown-time disclosure retains its Team-wide historical scope.

The same pure selection callback and snapshot lifetime from
[ADR-0082](0082-overview-deferred-previews.md) cover preview lookup. The existing
PostgreSQL and memory Adapters exercise the same Interface contract. No new
Module or mock-only Seam is added. This provides Leverage to page callers while
keeping selection and publication decoding Locality in the existing Modules.

## Limits

This increment does not introduce SQL metric aggregation or a persistent
statistics read model. Session pages still need both periods for their visible
comparison metrics, but omit chart and dimension aggregation. JSON part decoding,
Team-wide options and all-time directory limits remain future scaling work.
See [Team Overview](../../team-overview.md) for current evidence and scope.
