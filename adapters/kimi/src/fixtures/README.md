# Kimi Code native fixture

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
resume/edit and fault-injection steps. Neither is presented as native fork,
compaction, child or interruption acceptance.
