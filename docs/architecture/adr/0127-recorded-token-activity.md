# ADR-0127: Recorded Token activity and interval evidence

- Status: Accepted
- Date: 2026-10-13

## Context

Session Analytics already reports inclusive input, output and cache counters by
Session, model and Thread. A missing classification makes its existing total
unknown. Users also need to locate high-consumption intervals and understand
which recorded samples support a cache ratio. Usage has no Canonical Event
association; neither a similar identifier nor a nearby timestamp proves one.

## Interface alternatives

| Interface | Depth, Leverage and Locality | Decision |
| --- | --- | --- |
| Add Token counts to the existing Event activity buckets | Reuses the existing view, but leaks Event-based bounds into Usage accounting; samples outside the Event span disappear and model selection changes unrelated record semantics. | Reject. |
| Extend the existing Session Analytics Module with a scoped Token report and separate interval selector | Hides Usage aggregation, coverage, cache cohorts and interval derivation behind the same `Open` Interface. Reuses the authorized current-snapshot Seam and conditional reader Adapter. | Select. |
| Introduce a separate persisted consumption read model | Could reduce read-time work, but adds freshness, authorization, invalidation and worker ownership before measurements justify them. | Defer. |

## Decision

Opt-in Analytics v5 requires `tokenActivity` and preserves v2-v4 representations.
Its Thread and opaque model selectors scope this report; other summaries keep
their existing Session-wide meaning. The report provides per-column known
subtotals and sample coverage without changing existing nullable total semantics.
An absent classification is not zero. Total includes only samples with both
input and output; cache counters are already included in input. Overflow makes
the subtotal unavailable and is explicitly reported.

Cache shares use one cohort: samples with valid input, cache-read and cache-write
counters whose cache subdivisions do not exceed inclusive input. Numerators and
denominator come from those same samples. No eligible sample, zero denominator
or overflow yields an unavailable share. Other samples remain disclosed.

Usage v1 has always required a timestamp, independently of the nullable Event
profiles. Current Codex and Claude projections emit Usage only with an explicit
source timestamp. This report groups nonzero **stored Usage timestamps**; it does
not assign Event clock quality to Usage, infer provenance from another Event or
independently validate a historic clock. A missing clock remains in an untimed
subtotal. This increment adds no Usage clock-quality classification or durable
format change.

At most 60 uniform buckets span the selected Usage timestamps, using the same
overflow-safe interval arithmetic as recorded activity. Every timed selected
sample enters exactly one bucket, including samples before or after all Events.
Intervals are `[from,to)`, with an inclusive final endpoint. A single instant
has one point interval.

Each bucket returns a separate opaque `tokenRange`. `token_records` evidence
requires v5, that range and the current snapshot. The selector and cursor bind
Session, snapshot, analytics version, Thread and model. Evidence contains only
recorded-quality Events in the same Thread scope and interval. The model selects
the Usage-derived interval, not an Event's model or a causal relationship.
An interval can contain no eligible original records. Unknown or legacy Event
clocks are never placed into an interval by upload time or proximity.

The conditional Reader opens returned real Event anchors. Browser Back restores
the selection and page; scope changes clear incompatible range and cursor state.
Every read rechecks authorization and stale source tokens fail as before.

## Scope

Metric rules remain in the Go Module Implementation; Web remains Presentation.
The existing snapshot Seam and PostgreSQL/demo Adapters are sufficient. There is
no new interface for mocking, migration, Provider parser, Raw/Search join, worker,
cache or pricing dependency. Existing fact, response and cancellation bounds
remain in force. Monetary estimates, precise per-response attribution, context
occupancy and inferred efficiency remain outside this increment.

Behavior and validation are described in [Session Analytics](../../session-analytics.md).
