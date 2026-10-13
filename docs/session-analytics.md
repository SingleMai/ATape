# Session Analytics

Session Analytics derives deterministic statistics and a bounded evidence page
from the current authorized Canonical Session. The Go Module owns metric rules;
the HTTP Adapter exposes its `Open` Interface. The analysis view connects
statistics, normalized tool identities, recorded activity ranges and conditional
reader evidence links. This
guide describes implemented behavior. The [0.5.12 release notes](releases/v0.5.12.md)
own publication, deployment and acceptance evidence.
The 0.5.12 target-owned implementation restores native-tool and file-activity
projection in the official Codex/Claude Adapters through Canonical/publication
v5 and Analytics v4. The 0.5.11 bridge already includes supporting Host, Server
and reader behavior while retaining genuine older v3/v4 provider output.
Published 0.5.10 does not implement these contracts. See
[target-owned updates](cli/setup-and-adapters.md#target-owned-updates).
The Analytics v5 Token distribution below is a subsequent implementation
increment. The 0.5.12 delivery evidence does not establish its deployment. It
uses existing Canonical Usage without a new capture profile.

## Metrics and evidence

| Field | Meaning |
| --- | --- |
| `rootUserInputs` | Root-Thread user messages deduplicated by source order; delegated prompts are excluded |
| `messageFragments`, `thoughtFragments` | Stored Canonical message and thought fragments; not inferred turns |
| `toolCalls` | Distinct structured tool calls by Thread and tool call ID, merging later updates |
| V4 `identifiedToolCalls`, `unidentifiedToolCalls` | Calls with or without usable normalized tool identity; their sum equals `toolCalls`, excluding unlinked legacy Events |
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
No work time, tool execution duration, cost, productivity score, inferred outcome
or generated summary is provided. Record span describes the first and last
eligible stored source clocks. Codex projection v7 inherits projection v5's
correction of fabricated clocks and v4's historical missing-status correction
on successful source replay. Unreplayed
historical records can still carry an older Adapter's epoch or outcome; saved
non-null clock coverage alone does not establish clock quality. See
[Codex source clocks](adapters/codex.md#source-clock-quality-and-replay).

## Token consumption distribution and cache shares

Opt-in Analytics v5 requires `tokenActivity`. Existing Session `usage` totals and
per-Thread Token totals retain their unfiltered, complete-or-null semantics. The new report
independently selects a Thread and an opaque returned model key.

| Field | Meaning |
| --- | --- |
| `scopeThreadId`, `scopeModelKey` | Selected scope, or null for all |
| `samples`, `timedSamples`, `untimedSamples` | Recorded Usage samples and their stored timestamp coverage |
| `tokens` | Known subtotals with per-classification reported/missing counts and overflow flags |
| `untimedTokens` | The same accounting for samples without a stored timestamp |
| `cache` | Cache-read, cache-write and uncached input from one complete sample cohort |
| `models` | Model accounting within the selected Thread, before model filtering; an unreported model is null |
| `threads` | Thread accounting within the selected model, before Thread filtering |
| `buckets` | At most 60 intervals spanning selected stored Usage timestamps, with Token accounting and opaque ranges |

Each counter returns `knownSubtotal`, `reportedSamples`, `missingSamples` and
`overflowed`. Subtotals describe reported classifications, not a complete source
conversation. No reported sample returns null rather than invented zero; a real
reported zero stays zero. Total combines input and output only from the same
sample when both are valid. Cache is already in input and reasoning in output;
neither is added again. Single-sample or aggregate arithmetic beyond JavaScript's
safe integer range makes the subtotal null with `overflowed: true`, retaining
the reported sample count.

Cache shares use only samples with valid inclusive input, cache read and cache
write, with cache subdivisions not exceeding input. The same cohort supplies
every numerator and denominator. `eligibleSamples` and `missingSamples` disclose
coverage. Shares are fractions from zero to one; no eligible samples, a zero
denominator or overflow makes them unavailable. They do not estimate monetary
savings or cache effectiveness for unreported requests.

Buckets use **Usage timestamps**, independently of the Event activity span.
Usage v1 requires a timestamp; current Codex and Claude readers emit samples only
when an explicit source timestamp is present. This report describes stored Usage
time, without inferring Event clock quality or independently verifying historical
clocks. Missing dates stay in the untimed subtotal; upload/observation time never
fills them. Samples before or after all Events still enter the distribution.
Intervals are `[from,to)` except the inclusive final endpoint; a single instant
produces one point interval.

The Web displays known subtotals, coverage, cache shares, model and Thread
selections, all buckets and up to five high-consumption intervals. Hotspots rank
usable known total subtotals, retaining partial-coverage disclosure. This is
recorded consumption, not context occupancy or per-response generation speed.
No recorded Usage means unavailable, including Cursor's current capture scope.

Select an interval using `metric=token_records`, its returned `tokenRange` and
the same snapshot. The selector binds Session, version, Thread and model. It
returns recorded-quality Events in that Thread scope and interval. **This is
interval navigation, not Usage-to-Event or model attribution.** No nearest Event
is invented. An interval can contain zero eligible records; the Web shows that
count and disables its original-record action. Unknown and legacy Event clocks
remain outside these dated ranges.

Model and Thread changes clear incompatible interval and page state. Conditional
Reader links and Browser Back retain the analysis selection; full refresh clears
all filters. Older v1-v4 Servers retain existing totals and explicitly mark Token
distribution unavailable. Web negotiates v5, v4, v3 and JSON through the existing
safelisted Accept header. See [ADR-0127](architecture/adr/0127-recorded-token-activity.md).

## Stable tool grouping

Analytics v4 groups structured calls by explicit tool identity and recorded kind.
Every row includes `key`, nullable `identity`, `name`, `kind` and the existing
outcome counts. A native tool or Skill uses its explicit name; an MCP tool uses
`server/name`. Calls without usable identity form `unknown` rows grouped by kind.
Changing a command title does not create another tool group. Versions 1–3 retain
their earlier display-label aggregation and label filters.

The `key` has the opaque shape `tool:<64 lowercase SHA-256 hex characters>`.
Select the returned key with the `tool` query in v4; clients do not construct it
from a displayed name. Identity and kind both participate in the group, so two
rows with the same name can still select different evidence. Pagination binds
the key, analytics version, snapshot and other filters. Each folded call keeps
its last structured update as the evidence anchor, with that update's display
title and Event kind. Calls retain explicit failed, pending, in-progress or
unknown results; a missing result never becomes success.

Identity absence preserves an earlier identity on the same Thread/call ID;
an explicit null clears it. Coverage is Session-wide, even when activity or
evidence selects a Thread. `unidentifiedToolCalls` includes older projections,
unsupported or invalid source signals and identity cleared by upload redaction.
It does not establish that tools were unused. An ordinary native tool can be
identified here while remaining unclassified in the separate MCP/Skill report.
Tool input/output and Raw data remain outside the analytics snapshot.

| Source | Explicit identity extracted by the current Adapter |
| --- | --- |
| Claude sourceCapture | Native `tool_use.name`; valid `mcp__server__tool` becomes MCP server/name, and `Skill` with valid admitted `input.skill` becomes a Skill name |
| Codex paged collection | Native `function_call`/`custom_tool_call` names; closed `CommandExecution`, `FileChange` and `ImageView` item types; native `McpToolCall` server/tool fields |
| Other Adapters and unavailable historical sources | No ordinary tool name is inferred from command titles, tool text or input bodies |

Adapters own this extraction. The existing upload preparation Module owns
redaction; the Server owns folding, grouping and evidence selection. A copied
identity keeps its admitted original field so field masking also clears the
copy. Invalid or missing names remain unknown rather than being guessed from
commands. Cost and inferred task success are outside this increment. See [ADR-0124](architecture/adr/0124-stable-native-tool-identity.md).

## Recorded file activity

Analytics v4 requires `fileActivity`. It reports recorded read, edit and search
invocations from explicit Adapter-normalized fields, including failed, pending
and unknown calls. An edit invocation does not prove a successful filesystem
change. Search paths describe the recorded **scope**, not matching files.

| Field | Meaning |
| --- | --- |
| `callsWithActivity`, `callsWithoutActivity` | Distinct folded structured calls with or without a nonempty usable path fact; sum equals `summary.toolCalls` |
| `uniquePaths` | Number of distinct exact recorded path strings |
| `readCalls`, `editCalls`, `searchCalls` | Distinct calls with that recorded operation; one call can enter multiple columns |
| `paths` | Rows with opaque `key`, exact `path`, distinct `calls` and three operation counts |

Repeated updates and duplicate path/operation entries do not inflate counts.
One call involving two paths enters each path row but enters Session coverage
only once. Paths keep their original spelling, including relative paths, case
and separators; ATape does not resolve a working directory or claim that two
spellings identify the same filesystem object. Relative spellings shared by
separate source contexts are aggregated as recorded strings, not physical files.
Statistics remain Session-wide; Thread and file/operation selections filter
only evidence. Each selected call returns its last structured update once, with
its display title and the existing conditional Reader target. Back restores the
selection and page; full refresh clears all filters and snapshot tokens.

| Source | Explicit recorded facts |
| --- | --- |
| Claude | `Read.input.file_path` → read; `Write`, `Edit`, `MultiEdit` file_path → edit; `Grep`/`Glob` explicit input.path → search scope |
| Codex | `CommandExecution.parsed_cmd[]` closed read/search entries with path; `FileChange.changes` map keys and explicit move_path → edit; `ImageView.path` → read |
| Unsupported or unavailable source facts | No inference from shell text, patch bodies, MCP input, search patterns or output lists |

The bounded original source field stays available to upload preparation when a
path is copied. Paths admit no C0/C1 controls or orphan Unicode surrogates and
at most 2,048 UTF-8 bytes; a call's array admits at most 64 entries and 4,096
UTF-8 bytes of decoded JSON. Invalid, incomplete or oversized recognized inputs
produce an explicit unknown/null fact, rather than a truncated path or partial
collection. Complete empty arrays and explicit null clear earlier facts; absent
result updates preserve them. Upload redaction also clears the complete call's
path fact if any path or copied original field is hidden, and clears display titles that may carry escaped or abbreviated path copies. Public tool identity clears independently.

`callsWithoutActivity` includes older projections, unsupported sources,
missing/invalid/oversized paths and redaction. It is not evidence of no file
access. Unavailable history remains unrepaired. Available history can replay
under Claude source profile `.4` or Codex projection/cursor v7 while retaining
Event IDs, revision floors, checkpoints and Raw acknowledgements. Frozen pending
publications retain their original bytes. No migration or analytics worker is
introduced. Earlier Analytics v1-v3 show this report as unavailable.
See [ADR-0125](architecture/adr/0125-recorded-file-activity.md).

## Recorded activity and range evidence

Analytics versions 3, 4 and 5 require an `activity` report. It selects every Thread or one
Thread using `thread`; summary, tools, capabilities and usage still describe the
full Session. Counts describe Canonical records, including fragments and tool
updates, rather than inferred conversational turns.

| Activity field | Meaning |
| --- | --- |
| `scopeThreadId` | Selected Thread ID, or null for the complete Session |
| `eventCount` | All Canonical Event records in that scope |
| `recordedTimeEvents` | Non-null clocks under the explicit nullable Canonical v3/v4/v5 contract |
| `unknownTimeEvents` | Explicit null clocks, regardless of profile |
| `legacyTimeEvents` | Other non-null clocks; retained as evidence but excluded from dated activity |
| `firstRecordedAt`, `lastRecordedAt` | Earliest and latest recorded clocks, or null when there are none |
| `recordSpanMilliseconds` | Last minus first; null with no recorded clock, zero for one instant |
| `backwardClockTransitions` | Per-Thread source-order transitions to an earlier recorded clock; unknown/legacy records are skipped and Threads are never compared with each other |
| `buckets` | At most 60 uniform dated intervals, including empty ones, with record/message/thought counts, folded tool calls and an opaque evidence `range` |
| `unplacedRange` | Opaque selection for unknown and legacy records, or null when there are none |

“Recorded” is a source-contract category, not an independent clock verification.
Legacy v1/v2 required a clock, and older Adapters could fill one without a source
fact. The Server cannot distinguish a legitimate old date from that substitution.
It therefore keeps those dates visible with a legacy category, outside the span
and dated buckets. Source replay under a nullable profile can admit corrected
clocks; unavailable history remains unrepaired. Existing summary known/unknown
counts retain their earlier non-null/null meaning and are not clock-quality
counts. No provider name or epoch heuristic selects clock quality.

Dated intervals are `[from,to)`, except the final interval includes the maximum.
An identical instant has one inclusive point bucket. Nonzero spans shorter than
60 nanoseconds use fewer bins so boundaries remain distinct. Every Canonical
Event enters the records count; a structured tool call enters the tool-call count
at its final folded update, with existing explicit-outcome semantics. Missing
clocks never acquire an upload, filesystem or observation time.

Select a bucket or the unplaced group to view its `records` evidence page. The
range binds Session, snapshot, analytics version and Thread scope. It only
selects an interval produced by the Server; arbitrary client time bounds and
granularity controls are not provided. Pagination retains that range, and each
Event opens the existing conditional Reader target. Browser Back returns to the
analysis view with its range, Thread and page selection. A full refresh clears
range, cursor, snapshot and filters together.

New Web requests v5, then v4 and v3, with the standard safelisted header
`Accept: application/vnd.atape.session-analytics.v5+json, application/vnd.atape.session-analytics.v4+json, application/vnd.atape.session-analytics.v3+json, application/json`.
The response remains `application/json`, with `Vary: Accept` and `no-store`.
Without opt-in, the Server retains v2 behavior and its cursor contract. A Server
supporting v3 can return activity with the original label-based tool rows. Older
Servers may ignore the vendor ranges and return v1/v2; Web shows existing
statistics and explicitly marks activity unavailable. Missing activity is never
presented as zero. This avoids a new custom-header CORS requirement for separate
Web/API-origin deployments. See [ADR-0123](architecture/adr/0123-recorded-activity-ranges.md).

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
report as unavailable; version-2 through version-5 responses must include it, even when empty.
Only distinct structured calls enter these counts. Older Events without a tool
call ID remain separately disclosed by `unlinkedToolEvents`.

Current source support is listed under [stable tool grouping](#stable-tool-grouping).
Captured child Threads participate in both reports. Old stored v4 MCP/Skill
facts remain usable; no Server request invents identities for old records.

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

Earlier v4 MCP/Skill projection acceptance used constructed native-format records, the
installed Adapter/CLI and real PostgreSQL/HTTP. The retained genuine Claude
corpus verifies other capture behavior but contains no corresponding MCP or
Skill invocation; a fresh recorded live invocation has not been validated.
That earlier acceptance does not establish the new v5 capture transition.

Current Claude capture requires explicit Host Canonical v5 support and a
Server advertising publication target v5. V5 Codex paged capture requires explicit
Host and Server Canonical v5 support. The published 0.5.10 Server does not
advertise either v5 path. Unsupported Hosts/Servers refuse before source reads
or progress writes; they do not silently downgrade identities. Upgrade the
Server and CLI/Adapter together when a supporting release is available.

Available source history can replay with stable Event IDs and higher projection
revisions. The Codex cursor is v7; an older Adapter cannot read it. Recovery
continues forward using a compatible runtime and retained progress, rather than
deleting checkpoints. Claude's new projection similarly requires a compatible
reader. Missing source history remains unidentified. Already frozen accepted
publication bytes, manifests and Raw acknowledgements are never rewritten.
See [the v5 ingestion contract](api/canonical-ingestion.md#v5-stable-native-tool-identity)
and [the upgrade boundary](cli/setup-and-adapters.md#stable-native-tool-identity-checkout-increment).

No compatibility is claimed between intermediate development-checkout v5/v4
artifacts. The 0.5.12 target-owned implementation includes the complete
file-activity contract; the 0.5.11 bridge does not produce it.

The earlier v4 source-metadata compatibility encoding and its genuine 0.5.8
recovery evidence apply only to v4 captures. V5 recovery metadata carries explicit
`atape.acp-centered.v5`; an old Host rejects it instead of treating it as v3/v4.
No v5 rollback compatibility is established by the earlier
[0.5.9 release transition](releases/v0.5.9.md#upgrade-and-recovery-boundaries)
or [ADR-0121](architecture/adr/0121-tool-identity-release-transition.md).

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
`usage`, version-2 through version-5 `capabilities`, version-3 through version-5
`activity` and clock-quality evidence, version-4/5 stable tool rows and
`fileActivity`, and version-5 `tokenActivity`.
Collection fields are arrays, including when empty. The selected version is
explicit in the body. Statistics describe the full selected Session except for
scoped recorded activity and v5 Token distribution. Thread and model select
Token scope; other filters select evidence. Each tool evidence anchor is its last structured update. Thought and
user-input evidence anchors identify the matching Canonical fragment; Thread
evidence anchors identify the first stored Event in a captured child Thread.

| Query | Contract |
| --- | --- |
| `snapshot` | Opaque conditional current-source token, at most 200 bytes; required on `/evidence` and when using `cursor`, `range` or `tokenRange` |
| `metric` | `tools` (default), `failed_tools`, `unknown_tools`, `user_inputs`, `thoughts`, `threads`, `mcp_tools`, `skills`, v3-v5 `records`, v4/v5 `files`, or v5 `token_records` |
| `thread` | Select evidence, v3-v5 activity and v5 Token distribution from one captured Thread, at most 500 bytes |
| `range` | V3/v4-only opaque server interval or unplaced selection, at most 512 bytes; requires `records` and the same snapshot/Thread scope |
| `tool` | V4 returned group key; v1–v3 exact displayed label; only the three tool metrics, at most 500 bytes |
| `capability` | Exact normalized name for `mcp_tools` or `skills`, at most 500 bytes |
| `server` | Exact normalized server for `mcp_tools`, at most 500 bytes |
| `file` | V4 returned opaque path key, only with `files` |
| `operation` | V4 `read`, `edit` or `search`, only with `files`; combines with `file` and Thread using AND |
| `model` | V5 returned opaque model key; selects Token activity without attributing Events to a model |
| `tokenRange` | V5 returned opaque Usage interval; requires `token_records` and snapshot; cannot combine with Event `range` |
| `cursor` | Opaque evidence continuation, at most 1024 bytes, bound to Session, snapshot, analytics version and filters |
| `limit` | Evidence items per page, 1–100; default 20 |

Unknown, duplicate, empty or malformed query values fail with
`400 invalid_request`. Unsupported filters and out-of-range limits fail with
`422 validation_failed`. A `tool` filter outside the original three tool metrics
is invalid; `capability` requires `mcp_tools` or `skills`, and `server` requires
`mcp_tools`. A server/name combination selects that MCP identity. All evidence
filters, including server and capability, bind the cursor.
V4 file and operation filters also bind it. V3/v4 ranges also bind it. V3/v4 evidence items require `clockQuality` as `recorded`,
`unknown` or `legacy`; `occurredAt` preserves the stored date or explicit null.
`evidence.nextCursor` is absent at the end; continuation retains the same source
token and filters. Each request rechecks authorization.
V5 retains v4 tools, files, activity and clock quality, adds required
`tokenActivity`, and binds model and Token range into continuation. Invalid range
and model combinations fail rather than silently changing scope.

## Snapshot consistency and reader opening

All Session, Thread, Event metadata and Usage inputs are read in one authorized
repeatable-read PostgreSQL transaction. Activated normalized publication reads
reuse `current_head`; source rows without an active head read legacy Canonical
data. A legacy token fingerprints the complete actual input, including Event
profile metadata, Usage and
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
server/name and Skill-name groups share an additional 2,000-group bound. File activity allows another 2,000 distinct recorded paths.
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
resets the metric to tools and clears Thread, model, tool, range, Token range,
cursor and snapshot filters
before reading the latest content, including when a previously selected item
was removed. Tool labels over 500 UTF-8 bytes remain visible in full; individual
label filtering is disabled on v1–v3, while metric and Thread filters remain
available. V4 uses the bounded group key even when an MCP display name exceeds
500 bytes.
Returning to the conversation revalidates access without displaying cached
content on failure and provides retry. Full refresh also clears capability, server, file and operation selections. Remaining product work includes explicit identities from
other Providers and non-tool Skill invocation signals. Measure real Session
sizes and read latency before adding indexed facts
or persisted derivation. Any future derived read model must bind
both source token and analytics version and validate current authorization and
freshness. The rationale is recorded in
[ADR-0118](architecture/adr/0118-session-analytics-current-snapshot.md) and
[ADR-0120](architecture/adr/0120-normalized-tool-identity.md), with recorded ranges
in [ADR-0123](architecture/adr/0123-recorded-activity-ranges.md).
