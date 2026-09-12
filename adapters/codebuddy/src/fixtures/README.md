# Controlled CodeBuddy CLI evidence

`native-2.124.0.jsonl` was generated on macOS arm64 with the locally installed
`@tencent-ai/codebuddy-code` 2.124.0 on 2026-09-12 UTC (2026-09-13 Singapore).
It contains no personal history. Three controlled headless turns produced:

1. A literal marker response with all tools disabled.
2. A Read of an absent controlled marker file, yielding a failed tool result.
3. Ordinary `--resume` after creating the marker file, yielding a successful Read.

Flags included `-p`, `--strict-mcp-config`, `--setting-sources ""`,
`--output-format json`, a fixed `--session-id` on creation and `--resume` on
subsequent turns. Tools were either `--tools ""` or `--tools Read --allowedTools Read`.
Only local fixture paths/CWD were replaced with `/fixture/codebuddy-project`.
Native IDs, timestamps, usage, roles, relationships and record types are retained.
The file has 15 records, 12 projected Events and five model-response usage samples.

A separate controlled `--fork-session` run produced the retained `native-fork-2.124.0.meta.json` with
`forkedFrom`. Installed code confirms that forks copy history and nested child
files live at `<session>/subagents/agent-*.jsonl`. These observations justify
rejecting those shapes; they do not validate collecting them.

Tests derive adversarial variants for malformed tails, attribution, duplicate
identities, changed contents, bounds and recovery. Those variants are synthetic
contract fixtures, not claims of additional native behavior or platform coverage.
