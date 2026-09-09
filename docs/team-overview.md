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

## Refresh and lifecycle

Refresh every 30 seconds while visible, pause while hidden, and offer manual
refresh with the last successful update time. Keep previous successful data on
refresh failure with an explicit error. Preserve filtering and scroll during
refresh. Newly arriving conversations show an explicit update action instead of
moving the list while it is being read.

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
- The Web landing page includes six metrics, a shared cache breakdown, global
  filters, an accessible chart and exact values, details and readable previews.
  Time range, a collapsed Filters action and an icon refresh share the header
  toolbar. Project/member/Agent/model controls appear only on request; applied
  conditions remain visible as removable chips. The refresh tooltip exposes the
  last successful update time.
  Session pages contain 10 entries; dimension tables contain 25 entries.
- Visible pages refresh every 30 seconds. Failed refreshes retain readable data;
  revoked access clears it. New conversation cards wait for explicit acceptance.
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
  fact category, including the comparison period. The limit applies before
  dimension filtering. Too-large ranges fail explicitly with HTTP 422; no partial
  totals are presented as complete. Very large Teams need a subsequent SQL
  aggregation/read-model increment; shorter ranges cannot fix a Team exceeding
  the all-time Session-directory cap. Deployment preflight found 57,707 messages
  in the dogfood Team's default comparison window, exceeding the original 50,000
  cap. A real PostgreSQL regression now verifies complete metrics and recent
  previews with 60,002 messages, and explicit rejection beyond the new cap.
  This bounded increase supports the current installation; it does not replace
  the planned large-Team aggregation work.
- Unknown-time disclosure currently covers retained Team messages, while usage
  coverage covers the active selection. Conversation preview excerpts are bounded
  to 1,500 source characters in PostgreSQL, then 360 visible characters. A request
  hidden beyond an unusually long source wrapper may have no usable preview.
- No packages were published and no deployed database was migrated as part of
  local implementation. The server migration must accompany later deployment;
  adapters must be upgraded to collect supported usage from available history.

The next increment is large-Team aggregation and broader source-coverage
fixtures, followed by configurable Team timezone if needed. Cost conversion and
alerts remain outside the accepted scope.
