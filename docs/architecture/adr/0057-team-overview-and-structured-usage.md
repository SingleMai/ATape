# ADR-0057: Team Overview and structured usage

- Status: Accepted implementation direction
- Date: 2026-09-10

## Context

[Team Overview](../../team-overview.md) requires authoritative Team statistics,
model-attributed Token usage, cache breakdowns and conversation drilldown. Raw
uploads are optional, and provider usage may repeat across content blocks or
cumulative notifications. Counting raw records or presentation cards is invalid.

## Alternatives

1. Have the Web Implementation fan out over Projects and parse retained Raw for
   usage. This has poor Depth and Locality, couples Raw availability to Canonical
   reads, and spreads deduplication and authorization into Presentation.
2. Add bounded, optional structured usage observations to Canonical ingestion,
   persist them atomically with their owning Session, and expose an authorized
   Team Overview Module Interface. This preserves provider knowledge inside the
   Adapter and gives callers filtered statistics and readable detail directly.

Select option 2. This is an additive capability; old clients omit usage and their
data remains explicitly unknown. Usage is not an ACP message or Search document.

## Interface and invariants

Provider Adapters emit usage identity, owning Thread, source revision and time,
model, and optional nonnegative safe-integer counters. Input includes cache read
and write after provider normalization; output includes reasoning when the source
includes it. The normalized total is input plus output. Cache components are
displayed as subdivisions, never added to that total again. Unknown is distinct
from zero. A record alone does not prove whole-Session coverage.

Ingestion derives server-owned identity from the existing capture namespace and
validates Thread membership. Usage revisions share the Canonical transaction and
replay contract. They do not alter event ordering, event counts or Search. A
higher revision replaces a sample; an identical revision with different content
is a conflict. Deleted Sessions remain tombstoned.

The Team Overview Module owns calendar boundaries, filtering, aggregation,
deduplicated Session counts, source-time activity, previews and paging. Its
persistence Seam has production PostgreSQL and a justified development/test
memory Adapter. SQL remains in the persistence Implementation. Resource limits
fail explicitly instead of returning apparently complete truncated statistics.

The HTTP Adapter only decodes input and maps Module results/errors. The Web
Effect Module owns request lifetime and refresh; Presentation renders the
ViewModel and emits intents. No business retry, persistence or cross-Project
orchestration enters a View.

## Consequences

The Interface provides Leverage for both summary and drilldown while keeping
normalization Locality in source Adapters. PostgreSQL migrations and controlled
source fixtures are required. Historic usage is recovered only from still
available sources; missing coverage is disclosed. No publication, deployment or
production database migration is part of implementation authorization.
