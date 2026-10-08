# Controlled native large Read manual reinjection evidence

This corpus records one Claude Code **2.1.263** root Session with two complete
96 KiB Read results followed by manual `/compact`, file reinjection and two
ordinary resumes. The [Claude guide](../../../../docs/adapters/claude.md) owns
implemented scope, caller acceptance and remaining limits. This source evidence
does not establish installed-package acceptance, publication, Server deployment,
browser acceptance or compatibility with other history shapes.

All six JSONL files are actual native snapshots: `seed`, `warmup`, `toolturn`,
`compact`, `continue` and `secondcontinue`. Each later file has the previous file
as an exact byte prefix. Preparation made only the declared literal workspace,
configuration, HOME and encoded-directory substitutions. UUIDs, API IDs, indices,
timestamps, flags, other message bytes, key order and LF boundaries remain intact;
JSONL was not reserialized. Original/transformed byte counts and hashes are in
`provenance.json`. The 13 complete-LF cuts are metadata derived from these six
files, not additional native snapshots, supplied files or invocations.

| Snapshot | Physical lines | Logical real Events | Recorded real API IDs | Latest input/output usage |
| --- | ---: | ---: | ---: | ---: |
| seed | 7 | 2 | 1 | 23/11 |
| warmup | 14 | 4 | 2 | 52/24 |
| toolturn | 29 | 12 | 4 | 130/64 |
| compact | 43 | 12 | 4 | 130/64 |
| continue | 51 | 14 | 5 | 159/77 |
| secondcontinue | 57 | 16 | 6 | 188/90 |

Event counts are source-derived expectations for the selected manual profile,
excluding internal controls; they are not reported Adapter test results. Split
assistant records update one real API usage identity at its latest source
revision. Summary API `msg_atape_manual_large_1_mock_5` has no assistant JSONL
record, so its controlled 51/19 response counters cannot be recovered as source
usage. Compact metadata and stdout do not fill that gap. The synthetic bridge
has zero numeric usage counters and is not a real API usage item. These mock
counters and native cost estimates are not provider billing measurements.

Both original disk files were exactly 98304 bytes: 192 ASCII lines of 512 bytes
including LF. The native Read input contained only `file_path`, without offset
or limit overrides. Each `toolUseResult.file.content` exactly equals its entire
disk file in UTF-8 bytes; `startLine` is 1 and `numLines`/`totalLines` are 193,
including the final empty line after the last LF. File hashes and counters are
recorded in provenance; the complete file bytes remain in the source receipt.

| Per-file value | Original native bytes | Transformed fixture bytes |
| --- | ---: | ---: |
| Original Read result frame, including LF | 198664 | 198628 |
| Reinjected file frame, including LF | 99342 | 99278 |
| Raw file content | 98304 | 98304 |
| Numbered tool-result content | 98968 | 98968 |

The tool response is text plan@0, Read A@1 and Read B@2. Each result at 22/23
names its own call at 20/21 through parent, `sourceToolAssistantUUID` and tool ID,
and results appear in call order. Final text25/26 shares one API ID at indices
0/1. Boundary B34 has null parent, logical parent text26 and manual trigger;
both preserved UUID arrays select text25/26 and summary S35 as anchor. Caveat36,
command37 and stdout38 precede reinjected file B39/A40, in that evidenced reverse
order. Each attachment has a new UUID, consecutive physical parent and no new
Read execution. Its entire `attachment.content` is decoded-equal and
serialized-byte-equal to its corresponding original `toolUseResult`. Filename
equals the Read input and receipt path literally. Original and transformed
frame/object hashes are recorded. The numbered tool-result block is a native
presentation of the file, distinct from the raw file receipt object.

The final source has 31 UUID records, equal to the old small manual corpus's UUID
graph by type, parent/logical-parent ordinals, root/Meta/summary markers and API
index. Raw values and physical positions differ: the old actual final source has
53 lines, this source has 57. It adds `mode: normal` and empty `atis-latch` at
30/31 before B and again at 42/43 after the file pair. Their admitted scope and
large-frame capture acceptance belong to the owning guide. The `last-prompt` at41 selects A40;
queues44/45 precede Meta46, synthetic47 and real user48. Meta46 and user48 share
one prompt ID; their actual parents follow A40 → Meta46 → synthetic47 → user48.
User48/reminder49/assistant50 and user54/reminder55/assistant56 are real resumed
turns. The slug first appears at B and remains unchanged thereafter. No retained
conversation UUID is copied.

Both resumed model requests contain S's complete text and native Read-result
representations. `selected-source-requests.json` retains relevant message
coordinates, complete short text/summary and tool metadata. Long Read-bearing
text is represented by its exact transformed UTF-8 byte count/hash and endpoint
marker previews, avoiding another full copy of these large values. SDK system
prompts and tool schemas are excluded. Original full request hashes are recorded;
complete request bodies remain temporary research evidence rather than repository
files. Model visibility is separate from Canonical projection semantics.

The capture ran one independent attempt with new Session, initially empty HOME,
configuration and workspace. Each phase used a fresh process while sharing those
isolated directories and Session. Seed used `--session-id`; subsequent phases
used `--resume`. Every source process exited 0. Actual argv, actual allowlisted
environment, file/config inventories, timing and binary hashes were recorded
before/after capture. The actual binary reported 2.1.263 and had unchanged SHA256
`ef5d2909c8af49f31ab6d5487e90316777bc2fac170adfe8160716caa8aaf4f9`.
The new saved harness and invocation results are execution authority; the old
edited harness is background only. Actual `/compact` prompt wording remains
`Preserve synthetic read context and continue from the tool final.`

The environment configured a loopback-only model endpoint and fake API key;
native Read executed against the synthetic disk files. The mock recorded seven
model requests, four token-count requests and six empty `/api/hello` bootstrap
GETs returning 404. No real provider was configured. Background/nonessential
traffic and updates were disabled by native environment controls; no OS egress
firewall was applied, so this evidence does not claim an independent audit of all
possible background network traffic. The 45-second TERM/50-second KILL and route
budgets were not exhausted. No personal history or credentials were read.

Path substitution maps the original `/tmp` and `/private/tmp` aliases to
`/fixture/native-manual-large-read-reinjection/{workspace,config,home}` and replaces
the encoded workspace component. It also replaces the embedded workspace suffix
inside relative `displayPath`, preserving its five `../` components. Origin paths
in provenance identify evidence, not replay dependencies. No binary, harness,
research script, derived-cut file or full SDK request is supplied. Exactly two
96 KiB files, one first-slug manual compact and two ordinary resumes are proved;
larger native sizes, repeated automatic Read compaction, changed files, other
tools, errors, child sessions and other reinjection orders are outside this
source evidence.
