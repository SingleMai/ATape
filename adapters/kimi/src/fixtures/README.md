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
resume/edit and fault-injection steps. These synthetic cases are not native fork, child or interruption acceptance.


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
