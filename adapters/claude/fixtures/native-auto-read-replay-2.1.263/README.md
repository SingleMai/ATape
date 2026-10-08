# Controlled native Read-turn automatic replay evidence

These files record two independent native Claude Code **2.1.263** root Sessions.
The [Claude guide](../../../../docs/adapters/claude.md) owns the implemented scope,
actual caller acceptance and remaining limitations; [ADR-0091](../../../../docs/architecture/adr/0091-claude-read-turn-automatic-replay.md)
records the selected decision. This corpus alone does not establish publication,
deployment, browser acceptance or compatibility with other Claude histories.

The recorded executable SHA-256 before/after capture is
`ef5d2909c8af49f31ab6d5487e90316777bc2fac170adfe8160716caa8aaf4f9`, also recorded
in every invocation result and the previous text/manual/Read-pair evidence.
Capture occurred on 2026-10-08. An installed binary wrote native UUIDs/timestamps,
actual Read receipts, parent links, automatic compaction, replay and resume data.
Deterministic loopback Anthropic Messages SSE supplied fake authentication, model
text/API IDs and token counters. No live model or provider billing is established.
Preparation read the existing source material and ran no new native invocation.

## Actual snapshots and logical expectations

The ten JSONL files are path-only substitutions of **actual native snapshots**,
five per case: seed, warmup, toolturn, continue and secondcontinue. Each snapshot
has its predecessor as an exact byte prefix, before and after substitution. Each
case's final recorded config transcript equals its secondcontinue snapshot.
The cases have distinct Session identities and are not combined into one source.

| Case | Session | Calls | Copied original UUIDs | Retained UUIDs |
| --- | --- | ---: | ---: | ---: |
| auto_single | 611cd738-0d92-41ce-b1e3-64ba1a10a70a | Read a.txt | 6 | 4 |
| auto | bb9cf168-c9d3-4fea-9428-bd7fc8460755 | Read a.txt and b.txt | 8 | 6 |

| Snapshot per case | Single Events | Dual Events | Distinct persisted API usage | Input/output |
| --- | ---: | ---: | ---: | ---: |
| seed | 2 | 2 | 1 | 23 / 11 |
| warmup | 4 | 4 | 2 | 52 / 24 |
| toolturn | 10 | 12 | 4 | 190093 / 64 |
| continue | 12 | 14 | 5 | 190122 / 77 |
| secondcontinue | 14 | 16 | 6 | 190151 / 90 |

Logical Event expectations count every original UUID/physical block slot once,
including Read calls and their own-call updates. Copied UUIDs, internal summary
and token-reminder attachments add no conversation Events or usage. Physical
source bytes remain complete. API block indices group a response and do not
replace existing `UUID:physical-slot` Event identities. Latest usage keeps one
identity per persisted normal API ID; split blocks do not multiply token counters.

## Original graph, copies and control witness

`auto_single` originals U/G/P/C/R/A occupy toolturn lines 20–25; copies occupy
26–31; B is line 32, S 33, and the real split-text final response is 34/35.
P and C share one API ID/model at indices 0/1. The original graph is a strict
physical chain, and R's parent and sourceToolAssistantUUID equal C's UUID.
Retained metadata names precisely P/C/R/A, not the extra copied U/G.

`auto` originals U/G/P/C0/C1/R0/R1/A occupy lines 20–27; copies occupy 28–35;
B is 36, S 37, and real final texts 38/39. P/C0/C1 share one API ID/model at
indices 0/1/2. R0 and R1 each name their own call through parentUuid,
sourceToolAssistantUUID and tool_use_id. Their parents differ from the previous
physical UUID. Retained metadata names precisely P/C0/C1/R0/R1/A.

Both sources select P/A as retained endpoints, A as B's logical parent, and S
as both retained anchors. B has a null physical parent; S is parented by B;
first final text is parented by S and second final text by the first. Original
and copied tool parents are not rewritten to S. G/A are total_tokens_reminder
attachments, not post-summary file reinjection. All UUIDs, line positions,
metadata arrays and later ordinary resume parents are in provenance.json.

Each copy's only difference is one newly added common top-level slug:
`elegant-riding-quiche` for single, `async-nibbling-bengio` for dual. Removing that
one serialized field produces the exact original line bytes, including field
order/LF and unknown fields. Session/CWD/version/ownership, UUID, parent, prompt,
API ID/index/model/usage, attachments and receipts otherwise remain unchanged.
The later snapshots preserve those two positions per repeated UUID; they contain
no further tool-bearing compaction or existing-slug replay round.

## Actual Read and submitted-model evidence

`callReceiptEvidence` and `diskEvidence` preserve own-call identity, exact paths,
positive line counters and actual disk bytes. Native successful receipts match
their call input and sourceToolAssistantUUID. Read a.txt returns
`ATAPE_NATIVE_READ_A: amber lynx 204.`; Read b.txt returns
`ATAPE_NATIVE_READ_B: violet crane 619.`. Known error/async/Agent/status markers
remain absent rather than being synthesized as false/null.

The single case actually reads **only a.txt**. b.txt exists in the workspace,
and the mock final response/summary mentions its constant, but no B call/result
executed. Those model claims are not a second Read execution proof. The dual case
has both actual own-call receipts. No overlapping wall-clock execution is proved.

source-requests.json keeps only relevant actual model-message blocks, request/
message/block indices and block metadata. Full original request hashes remain
in provenance; full SDK system/tool schemas are omitted. The final and both
resume requests load S's exact text and each executed Read result once alongside
the retained plan/tool blocks. `isVisibleInTranscriptOnly:true` does not mean S
was hidden from the model. Its internal user-shaped envelope is not a new human
prompt in the logical expectations.

The final result's submitted-model text differs from its JSONL result: native
assembly trims the trailing tab and appends a token-reminder suffix, retaining
request cache-control metadata. In dual Read, A text matches exactly but B is
transformed; in single, its only A result is the last and is transformed. Do not
claim complete raw-result/request byte equality or rely on final prose as proof.

## Controlled usage and source gaps

Automatic compaction uses the recorded CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=20 and an
artificial 190000 input-token counter on the tool-call response. No count_tokens
request was recorded. This exercises native persistence, not real tokenization,
provider limits or billing. Compact preTokens/postTokens are not API usage.

A summarization model request is captured, but its assistant API/usage record
is absent from JSONL. Toolturn stdout top-level usage is 190041/40; modelUsage
is 190092/59. The 51/19 delta matches the controlled mock summary response. The
logical source totals above include only persisted normal APIs, and do not invent
the missing summary usage from token metadata, stdout estimates or a response-ID
sequence gap. Artificial list-price cost estimates are not provider charges.

## Isolation, integrity and derived test cuts

Each invocation is a fresh process; each case shares its isolated workspace,
configuration and same Session across --resume calls. Recorded argv use
restricted/safe mode, only Read, manual permission with no prompts, empty strict
MCP configuration, no Chrome, Sonnet/low effort, --print and JSON output. Every
invocation exited 0, signal null, with empty stderr. Exact common argv plus each
mode/Session/prompt, controls and original result hashes are in provenance.

The older saved harness inherits HOME from process.env.HOME and the value was
not recorded: fresh HOME/global-context isolation is not established. Separate
config/workspace and restricted controls are recorded. The saved reusable dual
mock has later-edited plan text (synthetic files versus the actual two synthetic
files); native snapshots, recorded result argv and model messages are authority,
not an immutable reproduction claim for that later script.

Only literal isolated `/private/tmp`/`/tmp` workspace/config aliases and the
encoded project directory component were replaced with
`/fixture/native-auto-tool-replay/{workspace,config}`. JSONL was not parsed and
reserialized to generate these files. Original/sanitized hashes, path-only
transformation and all byte prefixes were checked; UUID/API IDs/timestamps/model,
usage and other metadata are unchanged. Research paths are provenance origins,
not required replay dependencies. No binary or research script is supplied.

Derived complete-LF prefixes—including every copy slot, B, S and each final
block—are metadata in provenance.json. No derived-cut files are supplied, and
these cuts are paging/append boundaries, not additional native invocations.
Incomplete copy/B prefixes retain the proved original frontier; caller acceptance
is recorded by the guide. Unselected tool-only/no-plan, reordered/error/async,
N/other-tool, child, file-reinjection, manual tool compaction, repeated existing-
slug tool replay, fork/rewind/cross-file and replacement shapes are not established
by these first-slug, one-round samples.
