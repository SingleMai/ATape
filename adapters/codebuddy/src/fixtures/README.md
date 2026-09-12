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

`native-fork-2.124.0.jsonl` and `native-fork-2.124.0.meta.json` retain a controlled
`--resume ... --fork-session --session-id atape-codebuddy-fork-21240` run with tools
disabled. Its 18 records contain the unchanged 15-record prefix plus one new turn.

`native-nested-fork-2.124.0.jsonl` was generated with the same installed version on
2026-09-12 UTC. To exercise a different CWD, the controlled fork files were copied
unchanged to the CLI data directory corresponding to a fresh temporary Project;
CLI resume only searches its selected directory. A native `--fork-session` run
created `atape-codebuddy-nested-fork-21240`, followed by ordinary `--resume` with
one literal marker prompt. The resulting 23-record file contains 18 Events and
eight usage samples. The sidecar still points to `atape-codebuddy-native-21240`
and is byte-identical to the retained metadata fixture. Fork-owned CWDs were
replaced with `/fixture/codebuddy-fork-project`; the copied prefix retains
`/fixture/codebuddy-project`. Only those fixture paths were sanitized.

Installed `SessionStore.deserializeSessionFromPath` restores the copied root ID
and the fork filename as `storeId`; `forkSession` copies history and stores that
restored ID in `forkedFrom`. The resumed native file therefore returns to the root
`sessionId` without changing its storage file. These samples establish that behavior,
not a general immediate-parent relation. `/branch` rewrites IDs and adds `forkedAt`,
so that separate native command remains unsupported. Nested child files live at
`<session>/subagents/agent-*.jsonl`; their membership is not yet covered.

Tests derive adversarial variants for malformed tails, attribution, duplicate
identities, changed contents, bounds and recovery. Those variants are synthetic
contract fixtures, not claims of additional native behavior or platform coverage.
