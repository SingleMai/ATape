# Controlled native exact-two-Read source evidence

This corpus records native source shape and caller expectations. The owning
Claude feature guide records implementation, verification, integration and
remaining scope. Preparation used no new native invocation or live model call;
this evidence alone is not a publication or deployment claim.

The native snapshots come from installed Claude Code **2.1.263**, recorded on
2026-10-08. Recorded executable SHA-256 before and after generation is
`ef5d2909c8af49f31ab6d5487e90316777bc2fac170adfe8160716caa8aaf4f9`, matching the
prior manual and automatic text corpora. Prompt/model text, API IDs and token
counters were deterministic loopback Anthropic Messages SSE mock responses with
fake authentication. Native CLI generated record UUIDs/timestamps, split records,
parents, actual Read outputs, source persistence and resume behavior. No provider
billing or overlapping wall-clock tool execution is established.

## Two independent cases and four native snapshots

`tool-only` is the primary, smallest case from
`/tmp/atape-claude-parallel-native.bGHpKD`. Two fresh native processes shared one
fresh isolated HOME, configuration, workspace and Session
`d0a2fe9a-191b-4666-9dfc-7edda5abc1e3`. The initial process used `--session-id`;
the next used `--resume` with that same ID. Both exited 0 with empty stderr.
`tools.jsonl` is an exact byte prefix of `resume.jsonl` before and after path
substitution. It has a tool-only response `[Read@0, Read@1]` and no text plan.

`text-plan` independently corroborates a distinct `[text@0, Read@1, Read@2]`
response layout. It comes from the **original, not previously path-sanitized**
`/tmp/atape-claude-auto-tail-native.aPAWtV/manual/toolturn.jsonl`; its recorded
SHA matches the independent `previous-manual-batch.json` extract. `warmup.jsonl`
is a native baseline snapshot and an exact byte prefix of `toolturn.jsonl`.
This is Session `cf19053f-9c3c-49b7-8fce-461ae05d8294`, separate from `tool-only`.
It uses an isolated configuration/workspace and synthetic-only history. The
saved harness inherits HOME from its parent; that value was not recorded, so
**fresh HOME is not asserted for this older case**. Its saved reusable harness
also has later-edited plan text differing from the actual source/request text.
Snapshots, result argv and captured model messages are the recorded invocation
authority; the saved script is not claimed as an immutable exact reproduction.

The four supplied JSONL files are complete actual native invocation snapshots.
No later compact/continue or auto six/eight-copy files are selected. These four
snapshots have no compact boundary, summary, replayed UUID, fork or child record.
The two cases are not merged into a synthetic Session or source prefix.

| Native file | Records | Candidate Events | Distinct persisted API usage | Input/output |
| --- | ---: | ---: | ---: | ---: |
| tool-only/tools.jsonl | 12 | 6 | 2 | 72 / 18 |
| tool-only/resume.jsonl | 19 | 8 | 3 | 101 / 31 |
| text-plan/warmup.jsonl | 14 | 4 | 2 | 52 / 24 |
| text-plan/toolturn.jsonl | 27 | 12 | 4 | 130 / 64 |

Candidate Event counts include ordinary user text, each physical text record,
each Read call and each matching tool update. User-shaped `tool_result` records
are tool updates, not additional user chat turns. Event identities remain
`UUID:physical-block-slot`; each selected record has physical content slot 0.
API block indices identify response grouping and do not replace that Event key.

Usage keeps one identity per persisted API `sourceUsageId` at its latest physical
revision. In `tool-only`, call indices 0/1 share API `_1`; `_2` is final text and
`_3` is the new-process resume answer. In `text-plan`, plan/calls share API `_3`
and both final text records share API `_4`; `_1`/`_2` are the seed/warmup history.
Do not sum repeated per-block observations. Exact latest line/end-byte revisions,
all native usage fields and counts are in `provenance.json`.

There is no summarization call or missing summary usage in the selected
no-compaction snapshots. The older run's later compact response does have the
previously recorded JSONL usage gap, but those files/requests are excluded here.
Artificial token counters and native stdout's list-price cost estimates are not
provider charges or measured tokenization. No usage is invented for Read itself.

## Native response and receipt graph

| Case | Plan | Call C0/C1 | Result R0/R1 | Next ordinary chain |
| --- | --- | --- | --- | --- |
| tool-only | absent | lines 6/7, API indices 0/1 | lines 8/9 | attachment 10, final text 11 |
| text-plan | line 19, API index 0 | lines 20/21, API indices 1/2 | lines 22/23 | attachment 24, final texts 25/26 |

Both call records are adjacent root assistant records, role assistant, model
`claude-sonnet-4-6`, one `Read` tool-use block each, distinct call IDs/UUIDs and
ordinary direct physical parents. The optional plan is exactly the preceding
single text record from that same API response. All selected call/result records
retain `version:2.1.263`, `isSidechain:false` and their case's Session/CWD identity.
Relevant absent flags remain absent; extracted metadata does not insert native
nulls for omitted `isMeta`, `agentId` or compaction flags.

The next two adjacent records are successful user-role single `tool_result`s in
call order. Each `tool_use_id` matches its own call; both `parentUuid` and
`sourceToolAssistantUUID` equal **that call's UUID**. Both result parents differ
from their immediately preceding physical UUID. Native Read receipts have type
`text` and exact successful file data; `is_error` is absent, not a synthesized
false value. No other record separates the required receipt slots. After R1,
ordinary strict chaining resumes from R1 through the attachment/final response.

Exact call/result UUIDs, fields, indices, flag presence and parent associations
are recorded in `provenance.json`. This response-batch evidence does not establish
a user fork, arbitrary old-call parentage or general parallel-result ordering.

## Actual disk and submitted-model proof

Both sources retain actual synthetic files `a.txt` and `b.txt`. Their exact bytes
and SHA-256 are recorded in each case's `diskEvidence`. The native
`toolUseResult.file.content` equals those disk bytes; its path matches the own
call input. Tool outputs contain the actual numbered text:

- Primary A/B: `ATAPE_PARALLEL_READ_A: amber lynx 204.` and
  `ATAPE_PARALLEL_READ_B: violet crane 619.`
- Older plan case A/B: `ATAPE_NATIVE_READ_A: amber lynx 204.` and
  `ATAPE_NATIVE_READ_B: violet crane 619.`

`source-requests.json` is a deliberately derived JSON subset. It keeps
relevant tool blocks, synthetic text, block metadata and original
request/message/block indices; SDK system context, tool schemas and unrelated
request fields are excluded. Complete original request hashes are retained in
provenance for traceability; those original research paths are not candidate
replay dependencies.

The primary final request and later resume request each include both tool
results exactly once in one user-content array. The older tool-final request
independently does the same. Both request tool-use blocks match the same native
calls. The second result's submitted text is not byte-equal to its JSONL result:
native request assembly trims the trailing tab and appends a token-reminder
suffix, with cache-control metadata in the final request. Selected evidence
preserves that distinction, both actual disk markers and the exact relevant
request blocks. Do not claim complete raw-result/request equality. The model's
final textual claim alone is not proof of Read execution.

## Derived test cuts, not native snapshots

Future caller tests can derive complete-LF prefixes from the native batch files.
No separate cut files are supplied. `provenance.json` records line/byte/hash and
candidate Event/latest-usage expectations for each cut. These are append and
pagination boundaries within one native invocation, not additional native runs.

| Case | Complete prefix through line | Candidate Events | Distinct usage | Input/output |
| --- | ---: | ---: | ---: | ---: |
| tool-only | 6, first call | 2 | 1 | 31 / 7 |
| tool-only | 7, second call | 3 | 1 | 31 / 7 |
| tool-only | 8, first result | 4 | 1 | 31 / 7 |
| tool-only | 9, second result | 5 | 1 | 31 / 7 |
| text-plan | 19, plan | 6 | 3 | 89 / 41 |
| text-plan | 20, first call | 7 | 3 | 89 / 41 |
| text-plan | 21, second call | 8 | 3 | 89 / 41 |
| text-plan | 22, first result | 9 | 3 | 89 / 41 |
| text-plan | 23, second result | 10 | 3 | 89 / 41 |
| text-plan | 25, first final text | 11 | 4 | 130 / 64 |

The second call and second final text expose the same API identity at a later
source revision. A future real Collector/PG test can acknowledge those in
different restarted daemon cycles and require one usage identity, rather than
relying only on same-page in-memory deduplication.

## Integrity and next independently provable scope

Only literal isolated CWD/workspace/config aliases and encoded directory paths
were changed to `/fixture/native-parallel-read/{workspace,config}` and its
encoded component. Native JSONL was not parsed and reserialized to generate the
snapshots. Original/sanitized SHA-256, sizes, strict prefixes and path-only decoded
equality were checked. UUIDs, API IDs, timestamps, model/usage fields and all other
metadata remain unchanged. Provenance records the source hashes and preparation
evidence. Original research paths are traceability origins, not required replay
dependencies; no research harness or complete SDK request is supplied here.

A potential next increment is root-only, exactly these two successful Read calls
from one API response, followed by exactly two own-call results in the sampled
order. Optional text-plan and tool-only layouts are distinct proven shapes.
Authenticate call/API/model/index membership against the currently committed
source prefix; the existing global call map alone is insufficient. An unfinished
first result must retain its expectation through fragmentation and usage/Raw
capacity, committing any pending next-result state only with the full record's
prefix/hash. Old projection-4 cursors need lazy bounded same-byte source proof,
not reset/replay or a new uploader.

This material does not authorize N-tool batches, reversed/error/async results,
non-Read tools, child/Agent/Task capture, interleaving, compaction during a pending
batch, auto six/eight-copy profiles, arbitrary historical-call parent exceptions,
fork/rewind, atomic source replacement or a wall-clock concurrency guarantee.
The owning feature guide and caller checks record the selected implementation
scope and actual acceptance; this corpus alone does not expand those guarantees.
