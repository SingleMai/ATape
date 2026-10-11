# ADR-0123: Recorded activity ranges in Session Analytics v3

- Status: Accepted
- Date: 2026-10-12

## Context and boundary

Session Analytics has one deep Module and a small `Open` Interface over the
authorized Canonical snapshot Seam. Record span, activity buckets and conditional
evidence belong in that Implementation. Raw, Search and Reader pagination are
not time-analysis inputs. No new persistence, worker or test-only Interface is
needed. The snapshot Adapters preserve profile metadata needed for the decision.

The report describes recorded source clocks. It cannot establish work time,
active coding time, tool execution duration or time to first token. Parallel
Thread spans are not added. Record counts include Canonical fragments and tool
updates; folded tool-call counts retain their existing identity and outcome
rules.

## Clock admission

Codex projection v5 repairs available source history under Canonical v3, as
recorded in [ADR-0122](0122-explicit-legacy-source-clocks.md). Unavailable history
may still contain a fabricated epoch. Canonical v1/v2 required a non-null clock;
the Server cannot know whether a stored clock was substituted. Excluding only
epochs or a particular provider would guess at source semantics.

For activity, a non-null clock in explicit nullable Canonical v3/v4 is `recorded`.
It is not independently verified. Explicit null is `unknown`. Other non-null
clocks are `legacy`, remain visible as stored evidence and are excluded from dated
buckets and span. Unknown and legacy records remain selectable in an unplaced
range. Existing Session-wide summary known/unknown counts retain their v2
meaning. The UI explains that legacy dated records need source replay under a
nullable profile before inclusion. This conservative rule can withhold valid
legacy clocks and does not pretend those records have no stored date.

## Activity and evidence

The v3 activity report selects all Threads or one Thread. Summary, tools,
capabilities and usage remain Session-wide. The span is max minus min of recorded
clocks, null with none and zero with one instant. Per-Thread consecutive recorded
source-order clocks supply a backward-transition count; unknown and legacy
records are skipped, and Threads are never compared against each other. This
describes source order and does not prove a bad clock.

Use at most 60 uniform dated buckets, including empty intervals. A nonzero
nanosecond span uses `min(60, spanNanoseconds)` bins so boundaries remain strictly
increasing. An identical instant uses one inclusive point bucket. Intervals are
`[from,to)` except the final bucket includes the maximum. Arithmetic must support
the full admitted four-digit-year range without `time.Sub` saturation or
`UnixNano` overflow. The Server owns boundaries; Web displays them without
recomputing membership.

The `records` evidence metric retains every Canonical Event, ordered by
`sourceOrder,eventIndex,threadId,eventId`. A server-generated opaque range selects
an actual dated bucket or the unplaced range. Its binding includes Session,
snapshot, analytics version and Thread scope. A range requires that snapshot and
the records metric; it cannot combine with tool/capability/server filters. Page
cursors bind the range and all other filters; changing page size is permitted.
Every read retains authorization, stale-snapshot rejection and capacity bounds.

An evidence link uses the existing conditional Reader Event target. Browser
history identifies the analysis view, while its Session scope retains the range,
Thread and page selection. Returning from a source Event restores that selection.
Refreshing after a stale snapshot clears range, cursor and filters together.

## Compatibility and Locality

Web requests `Accept: application/vnd.atape.session-analytics.v3+json, application/json`.
An acceptable v3 media range opts into v3; absent it, new Server requests retain
the v2 response and cursor contract. Responses retain `application/json` and
identify the selected version in the body, with `Vary: Accept` and `no-store`.
This standard safelisted header avoids a new custom-header CORS preflight that
older Servers would reject in separate Web/API-origin deployments. An older
Server may ignore the vendor media range and return v1/v2; Web renders its supported existing report and explicitly
states activity is unavailable. Missing activity never becomes a zero report.
The v3 representation requires activity and evidence clock quality.

Preserving Event profile metadata also binds it into legacy snapshot identity;
profile changes invalidate conditional evidence. Publication heads already bind
their complete target. Schema and query metadata change without a database
migration. Existing time, fact, metadata and response limits remain enforced.

This increment adds fixed server ranges only. Arbitrary client time bounds,
brush selection, granularity controls, cost estimation and AI interpretation
remain outside this Interface. It neither publishes packages nor deploys the
Server.
