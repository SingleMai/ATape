# Kimi Code native fixtures

`native-0.42.0.jsonl` and `native-0.42.0.state.json` were generated on
2026-09-13 on macOS arm64 by the published `@moonshot-ai/kimi-code@0.42.0`
Node CLI, installed outside this checkout with npm lifecycle scripts disabled.
Upstream release commit: `6954d2c8bf94a5c7fc29cc6ae35b15d042cc4dcb`.

A fresh `KIMI_CODE_HOME` and empty Project/skills directories isolated the run.
The CLI's OpenAI provider pointed to a controlled loopback SSE server. No remote
model, account credentials or personal transcripts were used. Responses and token
counts are deterministic test data; serialization, request normalization, tool
execution and resume are native. This establishes the storage profile, not Kimi
cloud billing or the behavior of every model provider.

The commands were `kimi --skills-dir <empty> -p <prompt>`, then twice with
`--continue`. Prompts: “Say the controlled greeting.”, “Read absent.txt and report
the result.”, “Read sample.txt and report the marker.” The endpoint first returned
a split thought/text response; subsequent turns returned native `Read` calls
followed by thought/text replies. The missing file failed; the existing file
contained `ATAPE_KIMI_FILE_MARKER_0420`. There are 60 Wire records, three real user
turns, three thoughts, three replies, two calls, two results and five responses.
Total normalized usage: 540 input, 54 output, 100 cached-input tokens. Cache is
included in the 540 input total. Duplicated `usage.record`/`step.end` counters count
once. `turn.prompt` and its matching context message also count once.

Sanitization replaces only the controlled source home and Project paths with
`/fixture/kimi-home` and `/fixture/kimi-project`. Native IDs, timestamps, content,
tool schemas, system prompt and record order are retained. Upstream generated
prompt/tool text is from the MIT-licensed
[Kimi Code repository](https://github.com/MoonshotAI/kimi-code/tree/6954d2c8bf94a5c7fc29cc6ae35b15d042cc4dcb).
Its copyright and permission notice are retained in `LICENSE.kimi`.
The corpus is not evidence for legacy kimi-cli or newer/older Wire versions.

Runtime tests derive synthetic mutations to exercise limits, malformed/incomplete
records, source relocation/deletion, invalid relationships, Raw policy and lifetime.
The installed HTTP contract uses these native records plus explicitly synthetic
resume/edit and fault-injection steps. Synthetic mutations are not native behavior evidence; fork acceptance uses the
additional native fixtures below. Additional child evidence is described below; interruption remains unverified.


## Native context operations

The `context`, `auto` and `clear` 0.42.0 pairs were recorded on 2026-09-13/14
with the same published CLI/release commit, macOS arm64 and isolated local SSE
provider. They contain actual native Wire/metadata. No hand-authored context
operations are part of these fixtures. Paths alone were substituted with
`/fixture/kimi-project`, `/fixture/kimi-home` and `/fixture/kimi-skills`; native
IDs, timestamps, context summaries, counters and physical record order remain.
Native TUI prompts also generate `prompt.accepted` telemetry.

`context` starts with a headless prompt and resumes in the native TUI. It contains:

| Native action | Wire prefix length | Visible Events | Usage items | Input / output |
| --- | ---: | ---: | ---: | ---: |
| `KimiKeepOne`, then `KimiUndoBefore` | 32 | 4 | 2 | 203 / 23 |
| `/undo 1` | 34 | 2 | 2 | 203 / 23 |
| Replacement `KimiKeepTwo` | 46 | 4 | 3 | 306 / 36 |
| `/compact Keep KimiKeepOne and KimiKeepTwo.` | 52 | 4 | 4 | 410 / 50 |
| `KimiUndoAfter` | 66 | 6 | 5 | 515 / 65 |
| `/undo 1` | 68 | 4 | 5 | 515 / 65 |
| Another `/undo 1`: native TUI refuses to cross compaction | 68 (unchanged) | 4 | 5 | 515 / 65 |
| `KimiKeepAfter` | 82 | 6 | 6 | 621 / 81 |
| `/compact Keep the remaining controlled history.` | 88 | 6 | 7 | 728 / 98 |

`clear` is the new native Session produced by `/clear` followed by
`KimiNewAfterClear`. The old Session stays at 88 records; the new one has
20 records, 2 Events and 1 usage item (108 input, 18 output, 20 cached input).
The empty new Session before its first prompt had four metadata/config records.
Native metadata retains an automatically assigned title even after that turn is
undone; the Adapter preserves this separately saved title.

`auto` starts with `KimiAutoSeed`, then headless `--continue` with `KimiAutoNext`.
The local endpoint reports 190000 input tokens for the first response solely to
trigger native automatic compaction on the next turn. This is synthetic usage,
not measured input size or cloud billing. The 39-record native Wire puts the
second user message before the automatic compaction, then its model step after
completion. It yields 4 Events and 3 usage items: 190205 input, 36 output and
60 cached input. Compaction summary output estimates are not response counters.

Each local response contains `KimiContextReplyN`. In the manual history replies
2 and 5 are undone; replies 4 and 7 are internal compaction summaries. All seven
responses remain expenditure. Every response has 20 cached input tokens, already
included in input. Compaction `usage.record` has scope `session` and a model alias;
the matching `llm.request` provides the actual model `atape-context-model`.

Upstream semantics are recorded in `contextTranscript.ts` and
`replayBuilder/fold.ts` for retained reading history and the undo boundary,
`fullCompactionService.ts` for physical Wire ranges, TUI command dispatch for
`/clear` as `/new`, and `usageAgentModel.ts` with `defineAgentModel` default
`undoable: false` for preserved expenditure. All are pinned to the release commit
above. Tests mutate copies to reject incomplete/retried compactions, malformed
counters, undo across boundaries and unknown context operations.


## Native whole-session forks

`fork-0.42.0` and `nested-fork-0.42.0` were generated on 2026-09-14
with the same published CLI, isolated home/Project and local endpoint. Only the
three controlled paths were substituted as above. The source `context` Session
remained byte-identical at 88 records throughout these operations.

`kimi fork <context-session-id>` copied those 88 records verbatim and appended
one native `forked` marker. New metadata contains a distinct `id`/`createdAt`,
original CWD and direct `forkedFrom`. The marker has no parent ID, and its timestamp
slightly precedes metadata creation. Headless `--resume <fork-id>` produced the
next prompt/reply; native TUI `/undo 1` removed it, followed by headless replacement.

| Native action | Wire prefix length | Visible Events | Usage items | Input / output |
| --- | ---: | ---: | ---: | ---: |
| Whole-session fork of `context` | 89 | 6 | 7 | 728 / 98 |
| `KimiForkNext`, response 9 | 102 | 8 | 8 | 837 / 117 |
| `/undo 1` in the fork | 104 | 6 | 8 | 837 / 117 |
| `KimiForkReplacement`, response 10 | 117 | 8 | 9 | 947 / 137 |
| `kimi fork <fork-id>`, then `KimiNestedForkNext`, response 11 | 130 | 10 | 10 | 1058 / 158 |

The nested fork copies all 117 records and adds another marker before its own
continuation. Its parent remains at 117 records. Cached input is 20 per response
(180 and 200 respectively), already included in input totals. Usage includes
copied and undone responses and compactions, matching native `usageAgentModel`
without a fork reset. It represents each Session's captured history; it is not
proof that copied responses incurred new spend.

The public CLI uses the whole-session copy path in `sessionLifecycleService.ts`;
its SDK also exposes historical turn slicing, which this corpus does not validate.
Tests use actual native prefixes above, plus explicitly synthetic invalid-marker
and metadata mutations for diagnostics. Neither source-parent availability nor
a previously captured parent is required. All sources contain only the main agent.


## Native foreground subagents

`subagents-0.42.0/` contains a native metadata file and three native Wire files,
recorded on 2026-09-14 with the published Node CLI at the pinned commit above,
on macOS arm64. The isolated home, Project and empty skills directory used a
local OpenAI SSE endpoint and a controlled `sample.txt` containing
`KimiChildFileMarker`. Only home/Project/skills paths were replaced with the same
`/fixture/` paths as other fixtures. Native IDs, prompts, results, profile data,
record order and timestamps remain intact. No personal transcripts, cloud model
or account credentials were used.

The endpoint returned a foreground `Agent` tool call in response to
`KimiRootStart`; the child executed a real successful `Read`, then returned a
controlled answer. A native `--continue` process received `KimiRootResume` and
called `Agent(resume="agent-0")` with `KimiChildResume`. Another `--continue` with
`KimiRootSecond` created `agent-1`, which performed another real `Read`. The main
agent returned a text response after each native completed tool result. A prior
exploratory endpoint-routing error is excluded from this corpus.

| Native checkpoint | Main / agent-0 / agent-1 Wire records | Events | Usage | Input / output |
| --- | --- | ---: | ---: | ---: |
| Initial foreground child | 26 / 25 / absent | 8 | 4 | 410 / 50 |
| Resume the same child after CLI restart | 45 / 37 / absent | 14 | 7 | 728 / 98 |
| Create another child | 64 / 37 / 25 | 22 | 11 | 1166 / 176 |

The initial/resume tests use those exact native Wire prefixes and omit only the
not-yet-created `agent-1` entry from final metadata. Final metadata declares two
`type: sub` children with both parent fields set to `main` and profile `coder`.
The root has 12 Events and six responses (636 input, 96 output, 120 cached input).
`agent-0` has six Events across two delegated turns and three responses (311 / 41,
60 cached input). `agent-1` has four Events and two responses (219 / 39, 40 cached
input). Cache is already included in input. Parent result envelopes repeat child
answers but add no response usage.

Each parent Agent result starts with `agent_id`, `actual_subagent_type`, completed
status/reason, a summary and the native resume hint. The child's prompt has origin
`system_trigger/subagent`; it is not a root human prompt. `subagent.spawned` and
`subagent.completed` are observable runtime events in upstream code but do not
appear in these persisted Wire files. Correlation uses persisted metadata,
completed tool receipts, exact prompts and answers; it does not depend on runtime
notifications or parse a Session ID from arbitrary assistant text.

This corpus covers completed direct foreground children, real child tools,
multiple children and same-child resume. It does not establish background,
nested, forked, interrupted, failed or compacted/undone child behavior. Synthetic
mutations test incomplete files, unsafe paths, conflicting metadata, unpaired
receipts, wrong prompts/results and aggregate resource limits.


## Native nested foreground subagents

`nested-subagents-0.42.0/` was recorded on 2026-09-14 with the same released CLI,
pinned commit, macOS arm64, isolated home/Project/skills and local SSE provider.
Only those three paths were substituted. Native IDs, timestamps, profile metadata,
tool schemas, prompts, receipts and Wire order remain unchanged. No cloud model,
account credentials or personal history were used.

A user-level `nested-middle.md` declares `tools: [Agent]` and
`subagents: [coder]`. The first headless prompt is `KimiNestedRootTask: delegate to
nested-middle.` The native main Agent dispatches `agent-0` with profile
`nested-middle`, which dispatches `agent-1` with profile `coder`. The leaf executes
a real `Read` of `sample.txt` containing `KimiNestedFileMarker`, then each caller
receives its child's native completed result and returns its own answer.
`--continue -p 'KimiNestedRootResume: resume your middle agent and its leaf.'`
resumes both existing agents through their immediate parents.

| Native checkpoint | Main / middle / leaf Wire records | Events | Usage | Input / output |
| --- | --- | ---: | ---: | ---: |
| Three-level foreground delegation | 26 / 25 / 25 | 12 | 6 | 621 / 81 |
| Resume both levels after CLI restart | 45 / 44 / 37 | 22 | 11 | 1166 / 176 |

Both child metadata entries have legacy `parentAgentId: main`; the leaf's
`labels.parentAgentId` is `agent-0`. Upstream `agentLifecycleService.ts` writes the
legacy field as main, and `subagentMetadata.ts` resolves labels first. This is
native nesting metadata, not an inconsistency repaired by the fixture. Initial
acceptance uses the exact Wire prefixes above with the final family metadata;
only its update timestamp differs from the first native snapshot.

Root and middle each have eight Events and four responses (425 input, 65 output,
80 cached input); leaf has six Events and three responses (316 input, 46 output,
60 cached input). Cache is included in input. All responses use the controlled
model `atape-nested-model`. Leaf reply `KimiNestedLeafResumedReply9` appears in the
leaf and in its parent's receipt, but each model response contributes usage once.
Tests mutate copies for cycles, missing/misassigned parents, cross-parent resume,
incomplete leaf files, unsupported background/swarm/undo and UUID reuse across
parents. This does not establish background, failed/interrupted or fork/context
operations combined with nested children.


## Native completed background subagents

`background-0.42.0/` was recorded on 2026-09-15 (local time) with the same published
Node CLI 0.42.0/release commit, macOS arm64, isolated home/Project/skills and local
OpenAI SSE endpoint. Paths alone were replaced as above. No remote model,
credentials or personal transcripts were involved. Native Wire files retain all
IDs, lifecycle records, metadata, prompts, tool receipts, notifications and usage.
Native task JSON/output files were observed during research but are excluded from
the fixture; production collection requires only metadata and Wire.

The endpoint delays child responses so the parent's first reply finishes while
its child is still running. `KimiBackgroundRootStart` launches a coder child with
`run_in_background: true`; the child performs a real `Read` of a controlled file
containing `KimiBackgroundChildFileMarker`. Headless CLI waits for background work,
receives its native completion notice and emits another parent model response.
Three native `--continue` runs request `KimiBackgroundRootResume`,
`KimiBackgroundRootResumeForeground` and `KimiBackgroundRootSecond`. They resume
the original child in background, resume it in foreground, and launch a second
independent background child with another real Read. The local endpoint was
restarted before the foreground run while preserving response numbering; this
changes neither CLI metadata nor any persisted Wire record.

| Native checkpoint | Main / agent-0 / agent-1 Wire records | Events | Usage | Input / output |
| --- | --- | ---: | ---: | ---: |
| Initial background completion and notification reply | 38 / 25 / absent | 9 | 5 | 515 / 65 |
| Background resume after CLI restart | 69 / 37 / absent | 16 | 9 | 945 / 135 |
| Resume the same agent in foreground | 88 / 49 / absent | 22 | 12 | 1278 / 198 |
| Complete a second independent background child | 119 / 49 / 25 | 31 | 17 | 1853 / 323 |

Prefix tests remove only the final metadata's not-yet-created `agent-1` entry.
The root has 19 Events, four human prompts and 11 responses (1199 input, 209 output,
220 cached input). First child has eight Events/three delegated turns/four
responses (424 / 64, 80 cached input); second child has four Events/two responses
(230 / 50, 40 cached input). Cache is already included in total input. The model
name is `atape-background-model`; counters are controlled test data.

Each background run has its own task ID, typed start/terminal record, launch
receipt and notification origin, even when resuming the same agent ID. Native
notifications contain an output-file reference, not inline child text. Their
`turn.prompt` and `context.append_message` have origin `task` and no prompt/message
ID. Parent responses 5, 9 and 17 process those notices; they are model expenditure,
not additional human prompts. `task.terminated.outputTail` matches the child answer
(or its last 4096 UTF-8 bytes for larger output). No notification-referenced file
is read by the Adapter.

Synthetic mutations validate unfinished tasks, missing/duplicate/conflicting
lifecycle records, task/agent identity, notification context and output mismatch.
Rewritten notification paths prove that capture does not follow those paths.
This corpus does not establish interrupted/lost task recovery, nested background
children, mid-turn notification injection or fork/context-operation combinations.
