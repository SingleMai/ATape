# Controlled three-round automatic text replay source evidence

This corpus records three automatic text compaction rounds in one native Session.
Its snapshots establish source shape and chronology; the owning feature guide and
caller checks record automated acceptance and remaining implementation limits.
No personal history or real model was used.

Captured on 2026-10-08 from installed Claude Code **2.1.263**. The recorded binary
SHA-256 before and after generation is
`ef5d2909c8af49f31ab6d5487e90316777bc2fac170adfe8160716caa8aaf4f9`, matching the
manual and first automatic evidence. Five fresh CLI processes shared one fresh
isolated workspace, HOME, config and Session
`43526b2f-6f23-4f37-9627-c75f50bfb9b9`. Seed used `--session-id`; warmup and the
three continuation processes used `--resume` with that exact ID. All exited 0,
with empty stderr. Full argv, controls and original source-result hashes are recorded in
`provenance.json`.

Restricted/safe mode, manual permissions without prompts, empty MCP configuration,
no Chrome, synthetic system prompt, `--print --output-format json`, and disabled
updates/background/nonessential traffic isolated the run. The only available tool
was Read, which was never called. Deterministic loopback Anthropic Messages SSE
used fake authentication; no real model or provider charge was involved.

Native output supplies UUIDs, parents, timestamps, source copies, slug behavior,
compaction metadata, summary wrappers and same-Session resume persistence. Prompt
text, model text, API IDs and counters are mocked. Seed usage is 23/11; warmup and
each real postcompact answer report artificial **190000/13**. With
`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=20`, those answers trigger three actual native auto
workflows. These counters are controlled triggers, not evidence of actual tokens,
context limits or billing. Mock summary text mentions Read files, but no read ran.

## Five actual native snapshots

The five top-level JSONL files retain the original invocation names. `warmup` is
the ordinary before-auto baseline. Each continuation snapshot includes its new
user, replay, boundary, summary and real answer in one native process. There is
no separate native compact invocation or snapshot. Every original and sanitized
snapshot contains all predecessor bytes as a strict prefix.

| Native phase/file | Records | Unique candidate conversation Events | Distinct persisted usage | Input/output |
| --- | ---: | ---: | ---: | ---: |
| seed | 7 | 2 | 1 | 23 / 11 |
| warmup | 14 | 4 | 2 | 190023 / 24 |
| continue | 27 | 6 | 3 | 380023 / 37 |
| secondcontinue | 40 | 8 | 4 | 570023 / 50 |
| thirdcontinue | 53 | 10 | 5 | 760023 / 63 |

Candidate Event counts omit summary/attachment records and do not re-count U/G
copies. Raw retains every physical record. Usage keeps the latest revision for
each API `sourceUsageId`; IDs are `msg_atape_auto_text_mock_1`, `_2`, `_4`, `_6`,
`_8`. The final candidate is ten Events and five usage records totaling
**760023 input / 63 output**. These are source-derived expectations; caller checks establish capture behavior.

## Three independently witnessed groups

A is the latest ordinary one-text assistant, U is the new external user, and G
is that user's exact `total_tokens_reminder` attachment. Originals U/G are
physically adjacent, U.parent=A and G.parent=U. `[A,U,G]` is the current last three
unique UUID records. Copies U/G are immediately followed by new B/S, then the
ordinary answer. Each round has distinct fresh B/S UUIDs; no assistant, boundary
or summary is copied. Exactly these six U/G UUIDs occur twice; every other UUID
occurs once.

| Round | Native phase | A line | Original U/G lines | Copy U/G lines | B/S/answer lines | Slug mode |
| --- | --- | ---: | --- | --- | --- | --- |
| 1 | continue | 12 | 20/21 | 22/23 | 24/25/26 | first-added |
| 2 | secondcontinue | 26 | 33/34 | 35/36 | 37/38/39 | existing-unchanged |
| 3 | thirdcontinue | 39 | 46/47 | 48/49 | 50/51/52 | existing-unchanged |

Round 1 originals omit slug. Both copies add only
`slug:"rustling-watching-sunrise"`; deleting that one newly added field restores
complete decoded equality, including every unknown field. Their native serialized
bytes consequently differ. In rounds 2 and 3, originals already carry that slug;
copies are complete decoded deep equals and **exact native serialized line bytes**.
This byte equality also survives literal path substitution. Existing slug
replacement/removal or unrelated field normalization is not evidenced. Copies,
new B/S and answer share the same slug in each group.

Each B is root auto compaction with parent=null, logicalParent=G, head=A, tail=G,
exact `[A,U,G]` in both preserved UUID arrays and both anchors selecting S. S is
immediately next, parent=B, has both summary flags and the same promptId as U.
The real one-text answer is immediately after S and parented by S. A in rounds 2/3
is the previous round's real post-summary answer. All identified records retain
version 2.1.263, isSidechain=false and no agentId. No manual command envelopes or
synthetic bridge occur. B/S omit isMeta in this sample.

UUID-less metadata between A and original U varies: seven records in round 1,
six in rounds 2/3, including some last-prompt leafUuid references that point
forward to G. The sample does not establish exact metadata count/order or require
those leaves to equal the presently scanned UUID. All exact UUIDs, positions,
byte offsets, witness sizes, line digests and gap facts are in `provenance.json`.
Original and sanitized byte positions are recorded separately.

## Relevant model-message proof and usage gap

`source-requests.json` is an explicitly derived, selected model-message evidence
file. It preserves relevant source text blocks, block metadata and original
request/message/block indices; it excludes SDK system text, tool schemas and
unrelated request fields. The complete request capture remains in the temporary native-generation material
and is not supplied in this fixture. Original and sanitized complete-request
hashes are recorded for traceability; it is not a replay dependency.

There are eight Messages requests: seed, warmup, then one summary and one normal
answer for each round. Each postcompact request has roles `[user,assistant,user]`.
Its first user includes that round's exact persisted S.message.content once; its
assistant text is exact retained A, and its last user contains exact original U
plus the G reminder. The three phase-specific summaries are distinguishable.
Before rounds 2/3, the new summary-generation request loads the immediately
previous S exactly once; the next normal request uses the new S and no stale old
summary. Transcript-only flags do not imply absence from model context. Copies
do not introduce duplicate user turns in those model requests.

Each summary mock response uses 51/19, but no corresponding assistant JSONL record
exists. The sequential harness implies summary API IDs `_3`, `_5`, `_7`; the
source contains only real response IDs 1/2/4/6/8. Each continuation stdout reports
modelUsage 190051/32, whereas its persisted ordinary assistant has 190000/13;
the 51/19 difference is summary consumption. Three summary responses total mock
153/57 outside persisted usage. Do not invent usage from compactMetadata, summary
text or stdout. Source counters do not establish complete model consumption or
provider billing.

## Derived complete-LF test cuts

Tests derive two exact-prefix cuts per round from the provided native snapshot:
originals end after that round's G;
through-summary additionally includes copies/B/S. Cuts are computed from each
actual round's positions and bytes, not by reusing line 21 for later rounds.
They are append/pagination cuts, **not extra native invocation snapshots**, and
are not provided as separate files in this directory. The
witness suffix adds no candidate Events/usage from the originals cut; the next
real answer adds one Event/usage. Across complete native invocations, each round
adds the new original user plus that answer.

| Derived cut | Prefix through line | Original/sanitized bytes | Unique Events | Distinct usage | Input/output |
| --- | ---: | ---: | ---: | ---: | ---: |
| Round 1 through original G | 21 | 7298 / 7122 | 5 | 2 | 190023 / 24 |
| Round 1 through S | 25 | 11114 / 10814 | 5 | 2 | 190023 / 24 |
| Round 2 through original G | 34 | 14298 / 13932 | 7 | 3 | 380023 / 37 |
| Round 2 through S | 38 | 18112 / 17622 | 7 | 3 | 380023 / 37 |
| Round 3 through original G | 47 | 21303 / 20747 | 9 | 4 | 570023 / 50 |
| Round 3 through S | 51 | 25119 / 24439 | 9 | 4 | 570023 / 50 |

## Integrity and candidate limits

Only isolated workspace CWD/config aliases and the encoded directory component
are replaced with `/fixture/native-auto-text-replay-rounds/{workspace,config}`
and its encoded component. Source JSONL and complete request capture are not
reserialized. All other bytes, IDs, timestamps, metadata and control values stay
unchanged. Path-only decoded equality, original/new strict prefix chains, all
per-round equality modes, and model summary loading were checked.

| Native snapshot | Original bytes | Original SHA-256 | Sanitized bytes | Sanitized SHA-256 |
| --- | ---: | --- | ---: | --- |
| seed.jsonl | 2706 | `a2162784127482cfb11d1c42320c0082fb1ed0debfd5903032dd3da421ea8d8e` | 2640 | `0e7e9425e001540606d384a6ed8edd2157e394f16f86a743596cc6efa1ff57af` |
| warmup.jsonl | 5470 | `438078625900709726b7f2852f210b028f87e6e7c77208c8f49530d8bf6323e5` | 5338 | `f88cc44abdf44a485289a743b78c6f59fa2279aea6f128f9b045b574f01bd84e` |
| continue.jsonl | 12424 | `e4c7edc6c512ea7210fe448b1d355067ba3aea2869383f5cc7a6cb3d43790012` | 12102 | `c95d7ca08be4e6df538b660de72c1b346ec6efd42b678aecaa15a0f92f5e2c2d` |
| secondcontinue.jsonl | 19420 | `8f36e5ac833f80712d1d0645fd332735156ad5b02aa0b044f564438d6ee96a1a` | 18908 | `704466f523d99b734cdc82902f16806264bc90bde7cc6b5a2a4e112185cb3140` |
| thirdcontinue.jsonl | 26429 | `f53d7053d6a56ab9c4d5d50980f5007092cdb350d099de5eb6ea183f6bda3538` | 25727 | `334c129074427d20b61c309a920f35053bac98e0123cc3e300d36b83eef074b7` |

This establishes three sampled automatic root text groups and two exact slug
modes under one CLI version. It does not authorize arbitrary repeated records,
slug changes, copied assistants/API records, tool batches, other attachment
shapes, child compaction, missing/interleaved answers, rewind/fork, cross-file
continuation, other versions, Active Path replacement or atomic source snapshots.
An Adapter must authenticate each current A/U/G and fresh B/S group and
finish its prior answer before admitting the next; seen UUID membership alone
cannot authorize replay. Once-only can be a delivery policy, but is not a native
format requirement. Public collect pagination/retry/old-cursor, Raw policy, installed daemon and
authenticated PostgreSQL checks verify their respective caller boundaries. Their
results do not establish support outside this controlled source shape.
