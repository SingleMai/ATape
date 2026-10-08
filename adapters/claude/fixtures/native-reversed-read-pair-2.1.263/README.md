# Native planned Read pair with reversed successful results

This corpus records four actual Claude Code 2.1.263 snapshots from one root
Session: `seed`, `warmup`, `r1` and a later `ordinary-resume`. The first tool round
completes two successful Read results in B/A order and then performs one automatic
compaction. The later ordinary resume ran only after the new public Adapter
completely acknowledged r1; it is not a second dual automatic round. The
[Claude guide](../../../../docs/adapters/claude.md) owns implementation, actual
acceptance and remaining scope; these source facts establish neither package
publication nor Server deployment.

The binary SHA256 before and after each process was
`ef5d2909c8af49f31ab6d5487e90316777bc2fac170adfe8160716caa8aaf4f9`;
`--version` returned `2.1.263 (Claude Code)`. Each phase used a fresh process and
shared this case's initially empty, isolated HOME, configuration and workspace.
The executed harness hash matches its pre-execution record. Actual argv,
environment, exit results, configuration inventories and source/wire hashes are
recorded in [provenance.json](provenance.json). Original authority files remain
in the recorded temporary capture directory; their paths document origin and
are not fixture-reading dependencies.

The configured model endpoint was a fake-key loopback mock. The CLI sent four
empty `HEAD /api/hello` probes, answered with 404, and six fake-authenticated
`POST /v1/messages?beta=true` requests. No token-count request occurred. Routing
used the latest exact external prompt, explicit round state, fresh tool IDs and
the current native summary instruction. Historical substring matches did not
authorize a round. The mock's tool-call response reported 190000 input tokens and
`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=20` forced the controlled trigger. These counters
and native stdout list-cost estimates are not real provider billing. No real
provider credentials were configured. No OS egress firewall was applied, so this
record does not prove absence of every possible background connection.

Native JSONL was copied using only the declared literal isolated workspace,
configuration, HOME and encoded-directory replacements. It was never parsed and
reserialized for a snapshot. UUIDs, API IDs, indices, timestamps, metadata and
unknown fields remain unchanged. Original and substituted snapshots are strict
byte prefixes of their successors. The r1 source has 40 complete LF records,
26 physical UUID records and 18 distinct UUIDs; the final ordinary-resume source
has 46 LF records, 29 physical UUID records and 21 distinct UUIDs.
The native root CWD used the `/private/tmp` alias while call inputs used `/tmp`;
both declared workspace literals map to the same controlled fixture path.

| Native snapshot | Lines | Unique Canonical Events | Distinct persisted APIs | Input/output tokens |
| --- | ---: | ---: | ---: | ---: |
| seed | 7 | 2 | 1 | 23 / 11 |
| warmup | 14 | 4 | 2 | 52 / 24 |
| r1 | 40 | 12 | 4 | 190093 / 64 |
| ordinary-resume | 46 | 14 | 5 | 190122 / 77 |

Logical counts omit provider-generated summaries and replayed UUIDs. Usage keeps
one source API identity at its latest original-record revision. Split plan/call
or answer records and copied records do not multiply usage. These are source
expectations, not unperformed acceptance results.

The actual round has U20/G21, `text@0` plan22, Read A23 at index1 and Read B24 at
index2. Plan and calls share one response ID/model and `tool_use` stop reason.
Result B25 points to B24 through its parent, `sourceToolAssistantUUID`, tool ID
and literal file path. Result A26 points to A23 through those same own-call
fields; it does not follow B25's UUID. The trailing token reminder A27 follows
result A26. Native Read actually read `r1-a.txt` and `r1-b.txt`; their complete
54-byte and 56-byte UTF-8 bodies equal their receipts' `file.content`. The numbered
tool-result text is a native formatting transform, not the literal disk body.
Both receipts have startLine1, numLines2 and totalLines2, including the trailing
empty line. No error/async/child result is present.

Eight copies28–35 repeat U/G/P/callA/callB/resultB/resultA/reminder in that physical
order. Their only added field is the first slug `cryptic-gliding-brook`; removing
it reproduces each complete original decoded object, including unknown fields,
and exact serialized LF bytes. Boundary B36 has null physical parent and A27 as
logical parent. Its preserved six-UUID tail is P22 through A27 in the actual
reverse-result order, with summary S37 as anchor. S37 follows B36 and the real
answer F0/F1 at38/39 follows S37/F0. These answer records are text indices0/1 of
one fresh `end_turn` API response. This source contains no post-summary file
reinjection.

[Selected requests](selected-source-requests.json) retain relevant exact prompts,
conversation text, calls, results, summary and small mock responses. Full SDK
system/Read schemas and unrelated reminder bodies are omitted; original request
and complete SSE hashes remain recorded. Summary request7 contains no current
Read call or result. Final request8 loads the exact persisted S37 text and both
current results in B/A order. Model-context presence describes the observed
requests and does not authorize a source record by itself.
The ordinary request also loads the exact S37 text and both prior B/A results,
then adds its latest external prompt. Its one fresh `end_turn` answer adds
29/13 persisted tokens; no new tool call or automatic boundary appears.

Six mock API IDs were returned across both captures. Summary API4 reports mock
usage51/19 but has no assistant usage record in JSONL, leaving five persisted
source API identities at the final ordinary snapshot.
Native stdout `modelUsage` exceeds top-level usage by51/19 for r1. Neither
boundary metadata nor stdout estimates supply the missing captured summary
usage, so this corpus cannot establish complete summarization token accounting.

The old public Adapter completely acknowledged through B25 before rejecting A26:
9 Events, 3 APIs190052/41 and an exact 11804-byte original Raw prefix. Its saved
opaque cursor, receipt and authority hashes are recorded. The native r1 process
itself exited0; capture then stopped because the required full first-round
Adapter ACK failed. Prepared round2 files/prompts are not evidence of execution.
The previously failed unauthenticated bootstrap attempts belong to the broader
capture ledger and are not positive native snapshots here.

A separately authorized, bounded ordinary process then ran with the same
isolated HOME/config/workspace and Session. Before it started, an offline initial
candidate (`source0bd12099`, `bundle0446dfa2`) acknowledged the unchanged original
r1 completely:12 Events/4 APIs190093/64, exact25679-byte Raw and pending0, using
one Event per page, fresh runtimes and exact retries. That real opaque checkpoint,
receipt and gate artifact authority are recorded; later candidate fixes are not
retrospectively used as this gate. An earlier preparation hash check stopped
before any server/model/native process because it compared a mutable working
source to the frozen bundle. The corrected offline authority is recorded; this
was a setup stop, not a failed native invocation.

The only ordinary invocation exited0 with unchanged binary SHA and appended six
LF records to the strict original r1 prefix: queues41/42, real user43 parented by
F1 at39, reminder44, assistant45 and last-prompt46. The root identity and existing
slug remain stable. It used one fake-authenticated model POST and one HEAD404,
with no retry or second ordinary invocation. Deadlines were45s TERM/50s KILL and
90s overall. Its original final source is28697 bytes, SHA256
`26bba82b2f7b1dc099b006544714a88532017b146252c7929af10d1b95456b9f`.

Twenty-three complete-LF derived test cuts cover current originals, every copy,
B/S, F0/F1 and the ordinary U/G/answer. They are calculated from the native files,
not additional native calls or
checked-in cut files. Proposed caller expectations keep B25 pending for its own
remaining A result, and incomplete copy/B groups unacknowledged through A27.
Complete S37 remains pending until F0 is fully committed. The owning guide
records actual checks. This source does not establish tool-only reversed pairs,
more/mixed/error/async/interleaved tools, repeated dual automatic compaction,
manual reverse-result reinjection or children.
