# Native repeated dual-Read replay evidence (Claude Code 2.1.263)

This corpus records one actual bounded second automatic tool round and a later
ordinary continuation in the same
isolated native Session as the [reverse-result source](../native-reversed-read-pair-2.1.263/README.md).
The [Claude guide](../../../../docs/adapters/claude.md) owns implementation and
acceptance; these files establish controlled source facts, not release status.

`before-r2.jsonl` is the actual 46-LF source after that corpus's ordinary resume,
with this corpus's literal path substitutions. It equals the linked previous
snapshot after replacing both its declared fixture path prefix and encoded
directory component. `r2.jsonl` is the one actual native R2 snapshot: 74 LF
records, 51 physical UUID records and 35 distinct UUIDs. The original source is
51,063 bytes, SHA-256
`60924365fc42c75d6a438beddf4d9e76bbf957ca1795f5d39e00b4ec9335025d`, and
strictly extends the unchanged 28,697-byte first snapshot.

The source bridge is ordinary U43/G44/assistant45. R2 appends last-prompt47,
mode48, atis-latch49 and queues50/51, then U52/G53/plan54/Read A55/Read B56/
result A57/result B58/token reminder59. Each result's parent and
`sourceToolAssistantUUID` name its own call. R1 had reverse B/A completion;
R2 has A/B completion. U52 follows the ordinary assistant45 rather than R1's
final answer. Fresh call/API IDs and the exact latest external prompt drove
explicit mock route state, so old R1 tool history did not trigger R2 responses.
Native last-prompt47 points forward to A59 and its `lastPrompt` is exactly U52's
external prompt; it does not name the intervening ordinary assistant45.

Copies60–67 are exact serialized LF copies of originals52–59, including all
unknown fields and their existing `cryptic-gliding-brook` slug. New boundary68
and summary69 retain the six current P-through-reminder UUIDs in physical
order. Files70/71 follow S69 in A/B call order and contain the entire prior R1
receipt objects from physical results26/25, respectively. Their decoded and
serialized content objects equal those historical receipts; they are distinct
from the current R2 files. Answer72/73 follows the second file as two text blocks
from one new real API response. All native parent edges, timestamps, API IDs,
metadata and byte ordering remain in the supplied JSONL.

The 24 derived complete-LF cuts in `provenance.json` comprise 23 R2 cuts and
the ordinary continuation's final cut, not extra native snapshots or invocations. Original and sanitized hashes
are recorded for both native snapshots and every cut. Incomplete copied groups
preserve the previously proved prefix; complete S and each proved file are
separate Raw-only points with the answer still pending. These caller
expectations do not claim an unchecked Implementation passed.

The pre-invocation public Adapter gate used the frozen previous-main source
`01485f5a8e490102cacfe924b2f48fde8c165bb34bcb6373a7e80cc937f152ca` and
bundle `67a56a3089a4e1936ff34eeb044d3b31167d347b6f4083876957f952a44b2576`.
Its real opaque/Raw receipts prove 14 Events, five persisted API IDs, controlled
190122/77 counters and the exact complete 28,697 source bytes, pending zero.
After native R2 succeeded, that old Adapter stopped with `unsupported`
conflicting-slug evidence after result58: 20 Events, six API IDs, 380122/94,
36,174 Raw bytes. Native success and this incomplete public ACK are separately
recorded; that capture stopped without another native invocation.

`ordinary-resume.jsonl` comes from one later authorized native process only after
a genuine complete R2 public ACK on the frozen initial candidate source
`640f7c11a57b957b63b854ae1b10e41844d65d8ead6ec0608bc9df923d0e5b85` and
bundle `d540f752884bbe77464a00f7a3001fb903f97c507ef569f6ea9e66d8d727fa94`.
Its gate records 22 Events/seven API IDs/380163/117, all exact 51,063 bytes and
pending zero. That native process appends six LF records: queues75/76, ordinary
U77/reminder78/assistant79 and last-prompt80. U77 follows F1 73; it adds no tool
call or boundary. The original final source is 54,083 bytes, SHA-256
`9ee0a5db92cf02b7255d0e24df61ee3367fd853e36984dd272341e155e8f90cb`.
The initial candidate then completely ACKed 24 Events/eight API IDs/380192/130
and exact Raw bytes, pending zero. Native acquisition gates are separately
identified from later final acceptance artifacts. There was no further resume,
third round or retry.

Counting only first UUID occurrences and latest original assistant revisions
per API ID gives 22 Canonical source candidates and seven persisted API IDs at
380163/117. Copies do not create Events or usage revisions. The R1 and R2
summary API responses have no corresponding native assistant JSONL records.
R2 summary counters51/19 appear in mock/native stdout evidence, but are not
invented as persisted usage. The final model request actually loads S2 and
both historical file bodies, together with the two current Read results; the
summary request itself contains prior R1 context, not the retained R2 results.

The recorded actual process reused the same isolated HOME/config/workspace and
Session. Claude binary SHA-256 was unchanged before/after; `--restricted`,
`--safe-mode`, Read-only tools, disabled prompts/Chrome and strict empty MCP
controls matched the prior capture. Only a fake API key and loopback base URL
were configured. One HEAD `/api/hello` returned 404 and three authenticated
model POSTs completed for R2; the ordinary process observed one HEAD and one
authenticated model POST. Neither process issued count-tokens requests. The explicit 90s case
watchdog and 45s TERM/50s KILL bounds did not fire. Traffic suppression flags
and observed loopback requests are not an OS egress firewall or proof of all
network absence. The mock 190000 input counter and pct20 threshold are a
controlled compaction trigger, not real billing.

Only literal workspace/config/HOME/encoded-directory paths changed. No native
JSONL was constructed or reserialized. Selected model-message evidence omits
SDK system/tool schema and reduces the long summary instruction to marked exact
excerpts plus its hash. Full wire/SSE, actual argv/environment, process output,
configuration inventory and gate records remain in the temporary acquisition
origin recorded by hash, not repository reproduction dependencies. Historical
bootstrap/preparation limits remain documented in the linked prior ledger.
