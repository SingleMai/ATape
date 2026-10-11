# Session Analytics

Session Analytics derives deterministic statistics and a bounded evidence page
from the current authorized Canonical Session. The Go Module owns metric rules;
the HTTP Adapter exposes its `Open` Interface. The analysis view connects
statistics, normalized MCP/Skill identities and conditional reader evidence links. This
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
provided. Codex projection v5 corrects fabricated clocks and retains v4's
historical missing-status correction on successful source replay. Unreplayed
historical records can still carry an older Adapter's epoch or outcome; saved
non-null clock coverage alone does not establish clock quality. See
[Codex source clocks](adapters/codex.md#source-clock-quality-and-replay).

## Recorded MCP and Skill calls

Analytics version 2 adds `capabilities`: Session-wide `mcpCalls`, `skillCalls`,
`unclassifiedCalls`, `mcp` rows grouped by server/name, and `skills` rows grouped
by name. Rows carry calls and explicit completed, failed, pending, in-progress
and unknown outcomes. Counts fold updates by Thread and call ID exactly like
the main tool report. The final structured update remains the evidence anchor.
An absent identity preserves the earlier fact; an explicit null clears it.

These are recorded tool invocations, not installed or available capabilities.
A completed Skill tool does not establish that the requested task succeeded.
Unclassified calls include ordinary tools, old projections and unsupported
source signals. Zero identified calls does not establish that no MCP or Skill
was used. The Web accepts an older version-1 Server response and shows this
report as unavailable; a version-2 response must include it, even when empty.
Only distinct structured calls enter these counts. Older Events without a tool
call ID remain separately disclosed by `unlinkedToolEvents`.

| Source | Current normalized identity support |
| --- | --- |
| Claude sourceCapture | Explicit `mcp__server__tool` calls and `Skill` calls with a valid native `input.skill`; captured child Threads are included |
| Other Adapters and old stored records | No normalized identity is inferred from display labels, text or tool input in the Server |

Claude command expansion and Codex `<skill>` message markers are not tool calls
in this model and remain deferred. Reading `SKILL.md`, listing a skill directory
or mentioning a capability does not count as invocation. The Adapter preserves
only bounded identity fields in the ACP extension, before the existing upload
redaction. If any identity key or value is masked, the Host explicitly clears
the identity rather than grouping different secret names under one replacement.
If a field rule masks the original input/output value copied into identity,
the copied fact is also cleared. Unrelated masked arguments retain public
identity fields.
Tool input/output remain excluded from the analytics snapshot and response.

MCP/Skill projection acceptance uses constructed native-format records, the
installed Adapter/CLI and real PostgreSQL/HTTP. The retained genuine Claude
corpus verifies other capture behavior but contains no corresponding MCP or
Skill invocation; a fresh recorded live invocation has not been validated.

New Claude capture requires a Host that explicitly advertises Canonical v4 to
the Adapter and a Server advertising publication target v4. Older Hosts/Servers
refuse the unsupported path instead of dropping facts. Upgrade the Server and
CLI/Adapter before using this capture revision. Old records acquire identities
on a successful source replay, not from an analytics request. No frozen
publication or Raw receipt is rewritten. See [the v4 ingestion contract](api/canonical-ingestion.md#v4-normalized-tool-identity)
and [Claude upgrades](adapters/claude.md#recovery-and-upgrades).

Newly frozen v4 source recovery metadata uses a v3-compatible closed field and
an independent `canonicalProfileV4` fact. New readers normalize the effective
profile to v4; genuine 0.5.8 SourceCollector recovery has been verified without
source reads or rewriting frozen bytes. Actual target parts and comparison
profiles remain v4. Immutable 0.5.8 active-Claude upgrade parents still reject
the new manifest, so [the release transition](releases/v0.5.9.md#upgrade-and-recovery-boundaries)
requires a stopped external CLI refresh. See
[ADR-0121](architecture/adr/0121-tool-identity-release-transition.md).

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
`usage`, version-2 `capabilities` and `evidence`. Collection fields are arrays, including when empty.
Statistics always describe the full selected Session; filters only select
evidence. Each tool evidence anchor is its last structured update. Thought and
user-input evidence anchors identify the matching Canonical fragment; Thread
evidence anchors identify the first stored Event in a captured child Thread.

| Query | Contract |
| --- | --- |
| `snapshot` | Opaque conditional current-source token, at most 200 bytes; required on `/evidence` and when using `cursor` |
| `metric` | `tools` (default), `failed_tools`, `unknown_tools`, `user_inputs`, `thoughts`, `threads`, `mcp_tools` or `skills` |
| `thread` | Select evidence from one captured Thread, at most 500 bytes |
| `tool` | Exact displayed tool label for one of the three tool metrics, at most 500 bytes |
| `capability` | Exact normalized name for `mcp_tools` or `skills`, at most 500 bytes |
| `server` | Exact normalized server for `mcp_tools`, at most 500 bytes |
| `cursor` | Opaque evidence continuation, at most 1024 bytes, bound to Session, snapshot, analytics version and filters |
| `limit` | Evidence items per page, 1–100; default 20 |

Unknown, duplicate, empty or malformed query values fail with
`400 invalid_request`. Unsupported filters and out-of-range limits fail with
`422 validation_failed`. A `tool` filter outside the original three tool metrics
is invalid; `capability` requires `mcp_tools` or `skills`, and `server` requires
`mcp_tools`. A server/name combination selects that MCP identity. All evidence
filters, including server and capability, bind the cursor.
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
5,000 Threads, 2,000 distinct tool name/kind groups and 1,000 models. MCP
server/name and Skill-name groups share an additional 2,000-group bound.
Structured tool metadata is bounded to 8 KiB per Event. Aggregate Event metadata is bounded
to 32 MiB; the complete
JSON response is bounded to 2 MiB. Exceeding a bound fails explicitly with
`422 analytics_capacity`; no partial success is presented as full analysis.
The snapshot Adapter additionally bounds native source facts and selected
publication Event/Usage part bodies to 128 MiB. Native facts include Session,
Thread, Usage and Event metadata as well as original Event bodies; long source
identifiers contribute to these budgets.
The operation has a 12-second deadline and observes caller cancellation.

There is no migration, analysis worker, persisted result, cache, background
polling or Provider-specific Server logic. OpenTelemetry records operation
completion and failures without source contents. Unit and HTTP contract tests
cover metric accounting, evidence binding, typed errors and schema drift;
PostgreSQL integration tests cover authoritative snapshot selection and access.
Running a test and deploying this capability remain separate actions.

Local acceptance on 2026-10-10 covered PostgreSQL 17 native Canonical,
publication replacement and legacy adoption with retained child data. A fixture
with 60,002 Events and 6,000 Usage records returned analysis in 302, 284 and
259 ms on an Apple M5 Pro with a local Docker database. These are single-reader
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
content on failure and provides retry. Full refresh also clears capability and
server selections. Remaining product work includes explicit identities from
other Providers and non-tool Skill invocation signals. Measure real Session
sizes and read latency before adding indexed facts
or persisted derivation. Any future derived read model must bind
both source token and analytics version and validate current authorization and
freshness. The rationale is recorded in
[ADR-0118](architecture/adr/0118-session-analytics-current-snapshot.md) and
[ADR-0120](architecture/adr/0120-normalized-tool-identity.md).
