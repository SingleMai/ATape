# Session Analytics

Session Analytics derives deterministic statistics and a bounded evidence page
from the current authorized Canonical Session. The Go Module owns metric rules;
the HTTP Adapter exposes its `Open` Interface. The first increment connects the
Web analysis view, Server capability and conditional reader evidence links. This
guide describes checkout behavior and does not claim publication or deployment.

## Metrics and evidence

| Field | Meaning |
| --- | --- |
| `rootUserInputs` | Root-Thread user messages deduplicated by source order; delegated prompts are excluded |
| `messageFragments`, `thoughtFragments` | Stored Canonical message and thought fragments; not inferred turns |
| `toolCalls` | Distinct structured tool calls by Thread and tool call ID, merging later updates |
| Tool outcomes | Latest explicit completed, failed, pending or in-progress state; absent status is unknown |
| `childThreads` | Captured Threads with a parent; they remain within the owning Session |
| `knownTimeEvents`, `unknownTimeEvents` | Source-clock coverage; upload time never fills an unknown occurrence time |
| `unlinkedToolEvents` | Legacy tool Events without structured identity; not counted as unique calls |
| Usage | Recorded normalized Tokens, models and per-Thread totals; missing classifications remain null |

Input Tokens already include cache Tokens and output Tokens already include
reasoning where the Provider reports them. Total is input plus output when both
classifications are complete; cache columns are not added again. `recordedSamples`
and `incompleteSamples` describe recorded samples, not completeness of the source
conversation. Session and Thread `captureStatus` retain partial-capture disclosure.
No duration, cost, productivity score, inferred outcome or generated summary is
provided. Codex projection v4 corrects historical missing-status assumptions on
the next successful source replay; an unreplayed historical record can still
carry an outcome created by an older Adapter.

## HTTP Interface

Both endpoints require a Web Session Cookie, current `conversation.read` access
and return `Cache-Control: no-store`. Unknown and concealed Sessions both return
`404 not_found`. Raw and Search are not inputs; response items contain event
anchors and metadata, never conversation text or Raw bodies.

```http
GET /api/v1/sessions/{sessionId}/analytics
GET /api/v1/sessions/{sessionId}/analytics/evidence?snapshot={snapshot}&metric=failed_tools&limit=20
```

Both return the named `SessionAnalytics` representation in
[OpenAPI](api/openapi-v1.yaml): `snapshot`, optional publication `head`,
`analyticsVersion`, `sessionId`, `captureStatus`, `summary`, `tools`, `threads`,
`usage` and `evidence`. Collection fields are arrays, including when empty.
Statistics always describe the full selected Session; filters only select
evidence. Each tool evidence anchor is its last structured update. Thought and
user-input evidence anchors identify the matching Canonical fragment; Thread
evidence anchors identify the first stored Event in a captured child Thread.

| Query | Contract |
| --- | --- |
| `snapshot` | Opaque conditional current-source token, at most 200 bytes; required on `/evidence` and when using `cursor` |
| `metric` | `tools` (default), `failed_tools`, `unknown_tools`, `user_inputs`, `thoughts` or `threads` |
| `thread` | Select evidence from one captured Thread, at most 500 bytes |
| `tool` | Exact displayed tool label for one of the three tool metrics, at most 500 bytes |
| `cursor` | Opaque evidence continuation, at most 1024 bytes, bound to Session, snapshot, analytics version and filters |
| `limit` | Evidence items per page, 1–100; default 20 |

Unknown, duplicate, empty or malformed query values fail with
`400 invalid_request`. Unsupported filters and out-of-range limits fail with
`422 validation_failed`. A `tool` filter with a non-tool metric is invalid.
`evidence.nextCursor` is absent at the end; continuation retains the same source
token and filters. Each request rechecks authorization.

## Snapshot consistency and reader opening

All Session, Thread, Event metadata and Usage inputs are read in one authorized
repeatable-read PostgreSQL transaction. Activated normalized publication reads
reuse `current_head`; source rows without an active head read legacy Canonical
data. A legacy token fingerprints the complete actual input, including Usage and
Thread changes that do not advance the Session revision. `analyticsVersion`
versions metric semantics separately from source identity.

Tokens condition reads of current content; they do not retain old content or
grant access. If a head or legacy input changes, evidence and conditional reader
requests return `409 refresh_required`. Refresh the analysis before continuing;
do not concatenate pages from different tokens. Compression or rewrite is a
normal source change, regardless of how many times it occurs.

Open evidence through the [conversation API](api/conversation.md), retaining
the returned token:

```http
GET /api/v1/sessions/{sessionId}?thread={threadId}&limit=100&at={eventId}&snapshot={snapshot}
```

The reader returns `snapshot` for this conditional read. Publication readers
can additionally retain their existing `head`/`after` traversal. Legacy readers
still return their full Thread; `limit` does not add legacy paging.

## Capacity and operational scope

The first increment allows at most 100,000 Event facts, 100,000 Usage facts,
5,000 Threads, 2,000 distinct tool name/kind groups and 1,000 models. Structured
tool metadata is bounded to 8 KiB per Event. Aggregate Event metadata is bounded
to 32 MiB; the complete
JSON response is bounded to 2 MiB. Exceeding a bound fails explicitly with
`422 analytics_capacity`; no partial success is presented as full analysis.
The snapshot Adapter additionally bounds retained source data to 128 MiB.
The operation has a 12-second deadline and observes caller cancellation.

There is no migration, analysis worker, persisted result, cache, background
polling or Provider-specific Server logic. OpenTelemetry records operation
completion and failures without source contents. Unit and HTTP contract tests
cover metric accounting, evidence binding, typed errors and schema drift;
PostgreSQL integration tests cover authoritative snapshot selection and access.
Running a test and deploying this capability remain separate actions.

Local acceptance on 2026-10-10 covered PostgreSQL 17 native Canonical,
publication replacement and legacy adoption with retained child data. A fixture
with 60,002 Events and 6,000 Usage records returned analysis in 405, 281 and
264 ms on an Apple M5 Pro with a local Docker database. These are single-reader
fixture measurements, not a production latency guarantee. Current Go demo and
Web also completed analysis-to-child-Event navigation without intercepted
responses. The demo workspace sidebar still has an existing wire-shape mismatch;
this acceptance entered the Reader directly and does not validate that sidebar.

The Web view handles loading, failure, manual refresh and evidence navigation;
it preserves analysis state when returning from the reader. Changes to the
selected Canonical content require an explicit full refresh. Reloading analysis
resets the metric to tools and clears Thread, tool, cursor and snapshot filters
before reading the latest content, including when a previously selected item
was removed. Tool labels over 500 UTF-8 bytes remain visible in full; individual
label filtering is disabled, while metric and Thread filters remain available.
Returning to the conversation revalidates access without displaying cached
content on failure and provides retry. Remaining product
work includes MCP and Skills reporting once Providers expose reliable structured
facts. Measure real Session sizes and read latency before adding indexed facts
or persisted derivation. Any future derived read model must bind
both source token and analytics version and validate current authorization and
freshness. The rationale is recorded in
[ADR-0118](architecture/adr/0118-session-analytics-current-snapshot.md).
