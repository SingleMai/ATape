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

## Compaction samples

`native-compaction-2.124.0.jsonl` was generated on 2026-09-12 UTC with the same
native CLI version/platform. Four model responses produced 14 records:

1. A tools-disabled literal seed (`hy4-preview-f`), producing four records.
2. `/compact Keep the summary short: retain only the marker ATAPE_COMPACT_SEED_21240.`
   using `--model hy3 --effort low --max-turns 3`, producing a native command,
   thought and completed summary (seven total records).
3. Ordinary `--resume` with another literal marker (ten total records).
4. Ordinary `--resume` with `CODEBUDDY_PRE_MESSAGE_COMPACT=1` and
   `CODEBUDDY_PRE_MESSAGE_COMPACT_PCT=1` scoped to that process. The installed
   engineering strategy emits a `<cb_summary>` user context linked by
   `logicalParentId`, then the real user/assistant turn (14 total records).

All runs used `-p`, `--strict-mcp-config`, `--setting-sources ""` and `--tools ""`.
A preceding compact attempt with the default model timed out after 150 seconds;
its incomplete source was retained outside the repository, and the controlled
file was restored to the exact four-record seed before the successful attempt.
No incomplete output is presented as a successful native sample.

The Adapter projects ten Events and four usage records. The automatic context
has no Event and no invented usage. Original input is stored in the compact
text block’s `providerData.content`; its expanded internal prompt remains Raw.
Only the controlled absolute CWD was replaced with
`/fixture/codebuddy-compact-project`. Native IDs, flags, parent links, timestamps,
model responses and counters were retained. No sidecar was written for this
ordinary compacted Session.

`native-compaction-fork-2.124.0.jsonl` and its `.meta.json` are a native
`--resume atape-codebuddy-compact-21240 --fork-session --session-id
atape-codebuddy-compact-fork-21240` with one literal user/assistant turn. It copies
all 14 prior records and projects 12 Events/five historical usage records.
Only the same controlled CWD was normalized. Completed samples were copied to
scratch storage before deleting the three exact, byte-verified controlled source
files from the CLI home.

Automatic LLM summaries, emergency compaction, pruning/rewind and child-session
compaction have no native acceptance sample here and remain unsupported.
