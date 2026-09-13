# Team Overview

Status: requirements accepted on 2026-09-10; first implementation verified locally.

## Product contract

Team Overview is the shared management view of captured conversations and Agent
usage. Owners and Members see the same authorized statistics. It connects an
overview to filtered detail and the original conversation, with navigation state
preserved on return. Ordinary sign-in, the brand link and Team switching land on
Overview. Project and conversation deep links remain direct.

The page uses the Cozy Island theme and a continuous metric strip, one wide
usage chart, then a compact recent-conversation grid. It does not repeat the
sidebar's Project directory as its primary content. Desktop previews use two
columns; narrow screens use one. Structural icons share a consistent vector
style, with recognizable Agent identity, accessible labels and visible focus.

## Metrics and ownership

| Metric | Meaning |
| --- | --- |
| Team members | Current Team membership count |
| Active members | Distinct conversation owners with activity during the selected period |
| Active projects | Distinct Projects with conversation activity during the period |
| Active sessions | Distinct logical Sessions with activity, including continued older Sessions |
| User messages | Actual root-Thread user inputs; excludes tool results and delegated Agent prompts |
| Tokens | Recorded, deduplicated usage including captured child Threads |

A Session has one owning member, initially the authenticated capture User. There
is no within-Session multi-person attribution. Child Agents remain Threads of
their Session; they do not inflate Session counts. Transport retries and repeated
sync must not inflate metrics. The first increment does not infer cross-member
deduplication for separately imported copies of one source conversation.

## Time and filters

- Default to the last 30 days; offer 7, 30, 90 days and custom dates.
- Use the Team's shared timezone, initially `Asia/Singapore`, and display it.
- Compare with the preceding equally long period.
- Apply time, Project, member, Agent and model filters consistently across the
  metrics, chart and relevant conversation detail.
- Activity follows source occurrence time, not upload time. Historical imports
  belong to their historical dates. Unknown or invalid source times remain
  readable but are excluded from daily buckets and disclosed as missing.
- Agent/Harness and model are independent dimensions.
- Model-filtered Tokens include only matching model calls. A multi-model Session
  can appear in several model details but counts once in the overall total.
  Model Session counts are not additive; model charts prioritize Tokens.
- Model eligibility is evaluated independently for the selected and comparison
  periods. Matching usage in the previous period does not admit current messages.
  Filter choices retain the Team's full Agent directory and models observed across
  both periods, including choices outside the active dimensions.

## Token reporting

Show the total and input, output, cache-read and cache-write amounts together.
Normalize source-specific inclusive/exclusive counters so cache and reasoning
amounts are not added twice. Missing classifications are unknown, not zero.
Clearly distinguish recorded usage, partial coverage and complete source usage;
having any usage record does not establish full Session coverage. Do not estimate
missing Tokens from text length.

Deduplicate actual usage identities, including repeated Claude content blocks,
repeated source snapshots, source replay and collection retries. Attribute usage
to the actual model and source time. Child-Thread usage belongs to its Session
and owning member.

Historical usage backfill is best effort from retained readable sources. Lost
source data does not block the dashboard or require recovery. The product is in
development; preserving honest missing-data states is sufficient.

## Drilldown and reading

Metric links lead to member, Project, Session or usage detail. Chart dates and
Agent segments open corresponding filtered Sessions. Shared filters and detail
numbers must explain the overview. Details are paginated and link to Canonical
conversation URLs. Returning restores filters, page and scroll.

Recent conversations show 10 Sessions ordered by last actual conversation
activity. Each preview contains the latest root user input and the last meaningful
sentence of its responding Agent output. Skip tool output, system wrapping and
attachment declarations; show an explicit waiting state when there is no reply.
No AI summary generation is included. Keep identity metadata compact and preserve
body readability. Full reading remains in the Session reader.

The Session reader header shows the capturing user’s display name and avatar from
`session.capturedBy` (`id`, `displayName`, `avatarUrl`), followed by the Agent and
branch. This profile belongs to the capturing account, including when another
Team member reads the conversation. Missing profiles fall back to the source
actor; missing or failed avatars show initials. Canonical message authors remain
unchanged. The profile is read with the authorized conversation snapshot and
does not include email or external identity details.

## Refresh and lifecycle

Load data on entry and when the selection changes; offer manual refresh with the
last successful update time. There is no background polling or separate acceptance
action for conversation updates. Manual refresh updates all data visible in the
current view, including summary metrics and conversations. Keep previous successful data on refresh failure
with an explicit error. Preserve filtering and scroll during refresh.

Archived Projects continue contributing to history. Departed members retain
attribution for retained Sessions and are marked as departed. Current membership
count excludes them. Deleting a Project or Session removes its data from both
overview and detail. Reads enforce current Team membership.

## Architecture and verification

Presentation translates input/output. Effect-backed Modules own Web remote state,
refresh, cancellation and navigation persistence. Provider Adapters own usage
compatibility. Go Modules own authoritative authorization and aggregation. Raw,
Canonical and Search remain separate; a dashboard read does not parse Raw.

Acceptance checks:

1. Metrics and drilldown agree under combined filters and boundary dates.
2. Replay, repeated blocks and child Threads do not inflate counts or usage.
3. Cache/reasoning inclusions are normalized without double counting.
4. Historical imports do not manufacture current-day activity; unknown data is
   not rendered as zero or complete.
5. Model filtering attributes only matching usage and deduplicates Sessions.
6. Current membership, archival, departure and deletion are respected.
7. Refresh, errors and Back preserve reading position and filters.
8. Charts and controls are keyboard operable, contrast is readable, reduced
   motion is respected, and 375/768/1024/1440px layouts do not overflow.

## Scope and implementation status

The first release includes collection, structured usage, aggregation, available
history backfill, Overview, filtered detail and original-conversation navigation.
Cost conversion, budgets, alerts, performance scoring and generated summaries are
out of scope. Alerts are not planned in the near term.

Implemented in this increment:

- Claude and Codex Adapters emit optional structured usage even with Raw upload
  disabled. Existing cursors rescan retained sources once for usage backfill.
- Canonical ingestion validates and persists usage revisions transactionally;
  migration `000014_canonical_usage.sql` adds the PostgreSQL representation.
- `GET /api/v1/teams/{teamId}/overview` provides authoritative metrics, previous
  period, Agent/day series, member/Project/model details and paginated Sessions.
- `GET /api/v1/teams/{teamId}/overview/sessions` accepts the same query and returns
  metrics, comparison, options and the requested Session page from one snapshot.
  It omits chart and dimension tables and their aggregation. The Web uses this
  route after the first Session page; page zero reuses the full Overview. A 404
  falls back to an authorized Overview read for compatibility with older Servers.
  Other failures do not trigger fallback; revoked access clears previous data.
- Both routes accept `options=compact`. The new Web requests Project/member
  choices containing only `id`, `name` and `current`; omission preserves the
  legacy empty statistic fields for older Web clients. New Web decoders accept
  both formats. Current members without activity retain zero Session/Project
  counts and unknown usage, using an ID index to join options and activity.
- The Web landing page includes six metrics, a shared cache breakdown, global
  filters, an accessible chart and exact values, details and readable previews.
  Time range, a collapsed Filters action and an icon refresh share the header
  toolbar. Project/member/Agent/model controls appear only on request; applied
  conditions remain visible as removable chips. The refresh tooltip exposes the
  last successful update time.
  Session pages contain 10 entries; dimension tables contain 25 entries.
  Dimension-table pages reuse the loaded dashboard, including after manual
  refresh; their local page is excluded from the remote Session query. Remote
  query keys have stable field ordering, independent of URL parameter order.
- Pages refresh on demand without background polling. Failed refreshes retain
  readable data; revoked access clears it. Conversation cards use the latest
  successful response directly.
  Back restores the selected filters, page and reading position after data loads.

Verification includes all workspace typechecks and unit tests, the Web build,
browser regression tests, real Go API collection, and real PostgreSQL contract
tests. A native Claude fixture travels through the actual Adapter/CLI/Go path and
reports 1,926 inclusive input + 84 output = 2,010 Tokens, including 768 cache read
and zero cache write. Recollection does not inflate the two usage records.
Controlled browser fixtures provide layout examples, not claimed live Team data.

### Source compatibility and current limits

- Claude uses `message.id` to deduplicate repeated content blocks, taking the
  latest source position as its usage revision. Missing classifications remain
  unknown. Coverage inherits the existing Claude Adapter's supported topology;
  this increment does not add general compaction or unsupported subagent recovery.
- Codex counts only owned, top-level `token_usage_record.payload.usage`, keyed by
  Thread and response ID. It ignores cumulative/legacy `token_count` snapshots and
  compaction replays. Input includes cache; output includes reasoning. Model is
  the associated `turn_context` configuration, which cannot establish an actual
  provider fallback model. Sources without trustworthy response records remain
  unknown. See the pinned upstream [rollout schema](https://github.com/openai/codex/blob/ce2c2759ebee2d64565922f6f7365082284f9570/codex-rs/history/src/rollout_payload.rs)
  and [protocol definitions](https://github.com/openai/codex/blob/ce2c2759ebee2d64565922f6f7365082284f9570/codex-rs/protocol/src/protocol.rs).
- Team timezone is fixed to `Asia/Singapore` in this increment; there is no
  timezone settings UI. Custom ranges are bounded to 366 days.
- Aggregation uses one consistent bounded snapshot, with a 100,000-record cap per
  fact category, including the comparison period. Event and Usage limits apply
  after dimension selection and before paging. Member, Project, Session and model
  option directories retain Team-wide limits. Too-large ranges fail explicitly with HTTP 422; no partial
  totals are presented as complete. Very large Teams need a subsequent SQL
  aggregation/read-model increment; shorter ranges cannot fix a Team exceeding
  the all-time Session-directory cap. Deployment preflight found 57,707 messages
  in the dogfood Team's default comparison window, exceeding the original 50,000
  cap. A real PostgreSQL regression now verifies complete metrics and recent
  previews with 60,002 messages, and explicit rejection beyond the new cap.
  This bounded increase supports the current installation; it does not replace
  the planned large-Team aggregation work.
- Mixed legacy and publication reads select Session identities by Project,
  member and Agent, then scope native rows and current-head publication parts to
  those identities. Covered publication parts now use indexed message/Usage facts;
  only uncovered parts use the JSON compatibility path. Model selection narrows
  Usage and independently admits each period's message activity. Each selected
  fallback JSON part is decoded once for both Events and Thread classification. Body-free message facts and Threads are
  materialized before joining them. This prevents nested-loop
  plans from repeatedly decoding every selected publication body per retained
  Thread. Source-time filtering and selected-head visibility are preserved.
  The earlier JSON-query fix needed no migration; indexed facts require migration
  `000020_overview_publication_facts.sql`.
  On 2026-09-12, the deployed `OverviewEvents` query was observed still executing
  after 54 seconds. A read-only `EXPLAIN ANALYZE` of the revised SQL against the
  same installation returned 61,119 messages in 1.885 seconds, with the six
  selected publication parts each expanded once for Events. This is query-level
  evidence, not a deployed Server or end-to-end HTTP latency claim. A PostgreSQL
  regression exercises mixed legacy Threads and published root/child messages
  through `teamoverview.Open` with a five-second request budget.
- Statistics read narrow Session, Event and Usage facts without message text or
  ingestion provenance. Go computes the current page, then selects at most two
  root-message excerpts per returned Session (20 by default, 100 at the maximum
  page size). Both stages share one read-only repeatable-read transaction;
  selection cannot fetch an Event outside the authorized facts. Publication
  membership identifies exact current-head parts and entry indexes, with each
  selected part decoded once. The memory Adapter follows the same Interface.
  Previous-period aggregation computes only metrics. Event selection uses source
  order, Event index and a stable identity tie-break without a global fact sort;
  previews are formatted only for the returned page. See
  [ADR-0082](architecture/adr/0082-overview-deferred-previews.md).
- Local PostgreSQL verification on 2026-09-13 measured the 60,002-message
  `teamoverview.Open` regression at 86 ms (the preceding materialization-only
  version measured 594 ms). The mixed publication regression, bounded selection,
  pagination/comparison, permissions and selected-head contracts are covered by
  the persistence tests. A read-only production-data query check returned 61,119
  body-free facts in 631 ms and a separate sample of 20 selected publication
  excerpts in 31 ms. These SQL samples are not a deployed HTTP latency claim.
  Browser regressions cover local dimension pagination, Session paging, manual
  refresh, navigation restoration and revoked access.
- The subsequent filtered-query and Session-page increment was verified locally
  on 2026-09-13: the mixed publication regression took 159 ms, and the 60,002-message
  Overview took 97 ms. A small Agent selection beside 100,002 unrelated messages
  returned a complete Session page in 6 ms; the unfiltered request still rejected
  incomplete totals. Shared persistence tests cover combined dimensions, separate
  model periods, complete options and equivalence of visible page metrics. The
  publication regression covers filtered child usage and current-head withdrawal.
  Ten focused browser tests include page-only requests, coherent refresh, older
  Server fallback, failure retention and revoked access. These are local test
  measurements, not a deployed latency claim. See
  [ADR-0083](architecture/adr/0083-filtered-overview-and-session-pages.md).
- Unknown-time disclosure currently covers retained Team messages, while usage
  coverage covers the active selection. Conversation preview excerpts are bounded
  to 1,500 source characters in PostgreSQL, then 360 visible characters. A request
  hidden beyond an unusually long source wrapper may have no usable preview.
- Unknown-time reads use indexed messages for covered publication parts and
  decode only kind and occurrence time for uncovered current-head parts. They retain distinct-Session counting, Team-wide scope and
  deletion/head-replacement behavior. A preceding read-only production-data
  comparison measured the narrow query at about 98 ms versus 136–139 ms for the
  full visibility-view query; this is query-level evidence, not deployed latency.
- Go aggregation skips model-eligibility preparation when no model is selected,
  marks a Session only once within each group, and uses structured message keys.
  PostgreSQL fact conversion allocates its output slices once at the known row
  count. Preview authorization retains at most 100 selected identities rather
  than copying the complete Event identity directory; it still rejects any
  identity outside the authorized facts before reading text.
- The v0.4.8 CLI and official Adapter release contains usage collection and history
  backfill. Installations must upgrade the CLI and Adapters to collect supported
  usage from available history. The receiving Server must include migration
  000014 before these uploads; package publication does not perform deployment.
  The atape.net dogfood Server was upgraded and migrated on 2026-09-10; its initial
  dashboard verification had no usage records from the previously installed clients.

Session pagination still reads both periods for its visible comparison metrics.
Filtered reads retain a separate Team-wide model-option query, all-time
Session/Agent directories and unknown-time disclosure. Uncovered parts can still require
JSON decoding outside the selected dimensions; covered parts use indexed facts.
Cross-request caching and SQL metric aggregation remain unimplemented.

### Operation diagnostics and current verification

The Overview Module applies a 12-second execution budget, preserving earlier
caller deadlines and cancellation. PostgreSQL calls and aggregation checkpoints
share this context. Cancellation returns `service_unavailable` without partial
statistics; rollback has a separate bounded one-second cleanup context. This
budget starts after HTTP authentication and excludes response
serialization and transmission; it is not an end-to-end latency guarantee.

Each invoked operation produces a structured `Team overview completed` log with
the existing request ID, outcome, view kind and stage milliseconds. Slow operations
(at least one second) and failures use warning level. Stage names cover connection
acquisition/transaction begin, directories/authorization, Usage, Events, model
options, unknown-time disclosure, selection, previews and commit. Aggregate and
total durations are also included. Selection includes aggregation, so these
durations overlap and must not all be summed. PostgreSQL stages include decoding
and conversion work; cancellation cleanup belongs to the last active stage.
No filter values, credentials, query text or conversation content are logged.

`Server-Timing` exposes the same durations on operation responses, including
failures. Diagnostics are excluded from JSON business payloads. OpenTelemetry
spans on the Module and persistence Adapter carry durations when the executable
provides an exporter; no tracing backend is installed by this change. See
[ADR-0084](architecture/adr/0084-overview-compact-options-and-diagnostics.md).

The 2026-09-13 local PostgreSQL verification measured the 60,002-message Overview
at 72 ms and the small filtered page beside 100,002 unrelated messages at 5 ms.
These are individual local measurements. Tests verify a caller deadline cancels
a query blocked by a real PostgreSQL lock, retains failure-stage diagnostics and
allows a subsequent successful read. Persistence contracts cover unknown-time
deduplication, deletion and publication-head replacement; HTTP tests compare
compact/legacy choices and require identical statistics. Browser regressions
cover both option formats and current members with no matching activity.

`BenchmarkOverview` exercises 300 Sessions and 60,000 messages across two periods
through the same Module Interface. Its allocations include the memory Adapter
and JSON encoding; they do not describe production PostgreSQL peak memory.
The final local Session-page samples took about 19 ms, cumulatively allocated
38.7 MB per operation and made about 63,000 allocations. The preceding audit's
same-scale samples took about 23 ms with 42 MB and 123,000 allocations; these are
local benchmark comparisons rather than production latency or memory guarantees.
Compact choices reduce one representative option from 221 to 84 JSON bytes;
large option directories can still exceed the Web's 2 MiB response budget and
require a future searchable directory Interface.

### Indexed publication facts and operations

The first scaling increment from
[ADR-0085](architecture/adr/0085-overview-indexed-facts-and-aggregation.md) is
implemented. Migration `000020_overview_publication_facts.sql` adds
body-free message/Usage relations, time/model indexes and a nullable per-part
`overview_version` marker. Validation uses the already normalized Canonical batch
and bulk copies facts in its existing transaction; the version marker commits
with validation progress. Empty parts also get a marker. No active Session foreign
key is required before first activation. Activation still switches the current
head without scanning or rebuilding the target.

Events, Usage, model choices and unknown-time queries use indexed facts only
for parts marked version 1. Every uncovered part falls back to its normalized
JSON in the same read snapshot; branches cannot both count that part. Each
fallback part carries the complete validated topology, so partial backfill does
not need to decode a covered header. Page previews continue reading selected
body excerpts. Replaced facts follow bounded part reclamation through foreign-key
cascades. Native Canonical data keeps its existing relational write path.

The Server binary provides administrative commands using `ATAPE_DATABASE_URL`
(or its existing `_FILE` secret setting):

```sh
atape-server overview-facts status
atape-server overview-facts backfill --max-parts 32 --interval 100ms
```

These commands require the migrated schema and do **not** run migrations or
start a background worker. `status` reports retained normalized parts, missing
parts and missing parts belonging to current heads. `backfill` processes at most
32 parts per invocation (configurable from 1 to 32), in separate transactions,
with a 100 ms–5 s pause between successful parts. Each part is bounded to 4 MiB
and a five-second operation deadline; the whole command has a five-minute
budget and handles SIGINT/SIGTERM. Rollback has a separate one-second cleanup
budget. JSON output reports acknowledged completed parts and, on success, a
coverage snapshot. Failure exits nonzero and preserves committed checkpoints.

The marker makes repeated invocations resumable, including after an uncertain
commit response. Backfill locks only an incomplete part and skips locked work;
zero completed parts does not establish completion while `missingParts` remains
nonzero. It reads retained normalized Canonical data without Raw access, provider
conversion, receipt changes or validation-cursor changes. It includes retained
inactive candidates, since they may still become current. It can also prepare
unreclaimed obsolete parts; reclamation remains the owner of their removal.

Rollout sequence:

1. Deploy the additive schema and compatible Server through the separately
   authorized Server rollout. Schema preparation adds empty projection tables;
   it does not perform a full backfill inside the migration transaction.
2. Inspect coverage, then run bounded backfill commands under operator-controlled
   pacing. Monitor Overview stages, database load, write latency and storage.
3. Recheck both current-head and all-retained coverage. Older writers can create
   new missing parts, so one zero snapshot is not a permanent completion proof.
4. Keep the JSON fallback and normalized bodies during rollout and rollback.
   Older binaries can continue using their existing reads/writes with the
   additive schema. Do not drop the schema as an application rollback step.

The API, Go aggregation and existing fact/directory limits remain unchanged.
Indexed reads remove repeated body parsing but still transfer matching facts.
Additional row/index/WAL storage is outside the existing logical pending-payload
budget. This increment is not a large-Team capacity increase. The hosted instance
deployed commit `d8549b2` and migrated through schema 20 on 2026-09-13 UTC;
all six retained publication parts were subsequently backfilled. See the
[candidate-bound rollout evidence](releases/evidence/overview-d8549b2-rollout.md)
for recovery points, authenticated measurements and remaining acceptance limits.

Local PostgreSQL verification covers differential dashboard results across full
fallback, partial backfill and full coverage, including an empty part, split
root inputs, child activity, both model periods and missing token classifications.
Covered statistics also succeed with deliberately unreadable body bytes when
no preview is requested, demonstrating that statistics no longer decode those
bodies. Other checks cover invisible candidates, head replacement, permissions,
reclamation, projection failure rollback, resumable retries, pool restart,
concurrent backfill, locked parts and additive migration of retained heads.
Command tests cover execution bounds and refusal to migrate implicitly.

A same-data PostgreSQL 17 comparison on 2026-09-13 used eight 500-message
publication parts beside 1,043 additional legacy Threads, including page
previews. Alternating three samples per path produced medians of about 62 ms
for indexed reads and 142 ms for JSON fallback; a subsequent run measured 59 ms
and 132 ms. In that fixture, normalized parts totaled 7,808,894 bytes; the new
fact relations including their indexes occupied 868,352 bytes. The fixture has
message facts but no Usage, so this is not a general storage-amplification ratio.
Complete validation of a 500-message part had a sample median of 915 ms and a
maximum of 1.02 s; no prior writer baseline was measured. These are small local
warm-read/write samples, not production HTTP P95, cold-cache evidence or a
throughput claim.
Production concurrent-load, WAL/write-amplification and sustained reclamation
acceptance remain outstanding.

### Subsequent scaling work

The next independently verifiable increment moves aggregation and Session page
selection into PostgreSQL within one consistent snapshot, then addresses directory
limits according to measured cost. Keep this separate from facts preparation and
backfill so a metric-semantic migration does not obscure a storage/read regression.
Broader source-coverage fixtures remain useful; configurable Team timezone can
follow if needed. Cost conversion and alerts remain outside the accepted scope.
