# Native repeated automatic Read and prior-file reinjection evidence

This corpus records five actual Claude Code 2.1.263 snapshots from one root
Session: `seed`, `warmup`, `r1`, `r2` and `ordinary-resume`. Two automatic
compactions occurred in that Session. The later ordinary resume is not a third
compaction. The [Claude guide](../../../../docs/adapters/claude.md) owns the
implemented scope, acceptance results and remaining limitations; this source
record does not establish publication or deployment.

The binary SHA256 before and after every process was
`ef5d2909c8af49f31ab6d5487e90316777bc2fac170adfe8160716caa8aaf4f9`;
`--version` returned `2.1.263 (Claude Code)`. A new process ran each phase with the
same fresh isolated HOME, configuration and workspace. Actual invocation/result
records, configuration inventories, raw requests and raw SSE responses remain in
the recorded temporary source directory. Their hashes, actual argv/environment
and results are in [provenance.json](provenance.json); the executed harness hash
matched its pre-execution record. These origin paths document the capture and
are not dependencies needed to read this fixture.

Each phase used a fake credential and a loopback mock model endpoint. The native
CLI sent five empty `HEAD /api/hello` probes, answered with 404, and nine
fake-authenticated `POST /v1/messages?beta=true` requests; no token-count request
occurred. The mock routed the exact latest external prompt, current round state,
fresh round-specific tool IDs and the current native summary instruction. A
historical call or summary substring could not select the next round. The mock
reported `190000` input tokens for each tool response and used
`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=20` to force the controlled trigger. These
counters and stdout list-cost estimates are not real provider billing. No real
provider credentials were configured. No OS egress firewall was applied, so this
record does not prove absence of every possible background connection.

The original JSONL bytes were copied with only the declared literal replacements
for the isolated workspace, config, HOME and encoded directory component.
Records were not parsed and reserialized. UUIDs, timestamps, API IDs, block
indices, metadata and unknown fields remain intact. Original and substituted
snapshots are strict byte prefixes of their successors, and both hashes are
recorded. Final `ordinary-resume.jsonl` contains 65 complete LF records, 42
physical UUID records and 30 distinct UUIDs.

| Native snapshot | Lines | Unique Canonical Events | Distinct persisted APIs | Input/output tokens |
| --- | ---: | ---: | ---: | ---: |
| seed | 7 | 2 | 1 | 23 / 11 |
| warmup | 14 | 4 | 2 | 52 / 24 |
| r1 | 36 | 10 | 4 | 190093 / 64 |
| r2 | 59 | 16 | 6 | 380134 / 104 |
| ordinary-resume | 65 | 18 | 7 | 380163 / 117 |

These logical counts omit provider-generated summaries and replayed UUIDs.
Usage uses one source API identity at its latest original-record revision; split
text/call records and copied records do not multiply that usage. They describe
source expectations, not unperformed acceptance checks.

Each round emits `text@0, Read@1`, then one successful result parented by its own
call and naming the same `sourceToolAssistantUUID`. Native Read actually read
`r1-a.txt` and then `r2-a.txt`; each disk file is 56 UTF-8 bytes and equals the
receipt's complete `file.content`. The files differ by their round-specific
marker. This is evidence of two Read workflows in one Session, not of reading
the same filename twice. Call IDs and API IDs are fresh in the second round.

R1 originals occupy lines 20–25, with six copies at 26–31, boundary B32, summary
S33 and answer text records F0/F1 at 34/35. Copies add only the first slug,
`greedy-cooking-papert`; removing that property reproduces each entire original
object and serialized bytes. R2 originals are 42–47, copies 48–53, B54 and S55.
Every R2 original already has the same slug. Each R2 copy equals the whole
original object, including unknown fields, and its complete serialized LF line
is byte-identical. Each boundary retains exactly its current `P/C/R/A` four-UUID
tail, while the six copies also contain the current user and token reminder.
Both boundaries have a null physical parent and the current A as logical parent.

After S55, line 56 is a native file attachment from the *earlier R1* Read.
Its entire `attachment.content` object and original serialized object bytes equal
R1 result24's `toolUseResult` (also copied at line30), including every file field.
Its filename equals that receipt and the earlier call input, and its body equals
the original disk bytes. It differs from R2 result46. The attachment's parent is
S55; R2 F0 at line57 is parented by this attachment, then F1 at58 is parented by
F0. The old file contributes context rather than a new tool invocation or result.

[Selected request evidence](selected-source-requests.json) retains exact relevant
message blocks and small mock responses, with full raw request/SSE hashes. SDK
system/tool schemas and unrelated reminder bodies are omitted. S33's full source
text is loaded into request8 and the next round's requests10/11. Request11 has
the old R1 result and no current R2 result. Request12 loads S55, carries the
current R2 result and appends the earlier R1 Read as native reminder text;
request14 retains this context during the ordinary resume. Model-context
presence describes these observed requests; it does not authorize a source
record by itself.

Summary API responses4 and7 report mock usage51/19 each but have no assistant
usage record in JSONL. Native stdout `modelUsage` exceeds top-level usage by that
amount in each round. Boundary token metadata and these stdout estimates do not
supply missing persisted usage, so the fixture cannot establish complete
summarization token accounting.

The original R1 source was completely acknowledged through the public Adapter
before R2 began: one Event per page, a fresh runtime and an exact same-input retry
for every call, with a full 21339-byte Raw receipt and 10 Events/4 APIs190093/64.
The saved opaque checkpoint and receipt authority are hashed in provenance.
The old implementation then acknowledged R2 only through result46, at26576
original bytes, 14 Events/5 APIs380093/81, and diagnosed conflicting slug evidence;
the failed page and later ordinary resume retained that checkpoint and receipt.
This old baseline is separate from the complete source expectations above.

There are 36 declared complete-LF derived test cuts, covering both rounds'
originals, every copy, B/S, the earlier file, F0/F1 and ordinary continuation.
They are calculated from these five native files and are not extra native
invocations or checked-in cut files. Caller expectations keep incomplete
copies/B before the full summary unacknowledged, with one pending Session. A
complete S and the complete prior file each remain pending until full F0 commit.
Independent Raw receipts may stop inside an already proved group/file and be
retried with an older parser cursor. The owning guide records actual verification.

The excluded-attempt ledger is intentional. Two preliminary bootstrap attempts
incorrectly required fake authentication on native HEAD, exited143 and produced
no model request or JSONL; the corrected harness preserved them and removed its
blind setup retry. A separate formal dual-Read case completed only its first
native round: results arrived B then A, outside the ordered two-Read profile.
Its required complete old Adapter ACK failed, so no dual R2 was invoked and its
source is not a positive fixture here. This corpus does not establish repeated
dual Read, reversed/interleaved completion, more rounds, other tools, children,
manual compaction or arbitrary file reinjection.
