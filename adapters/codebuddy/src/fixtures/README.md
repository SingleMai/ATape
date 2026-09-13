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
so that separate native command remains unsupported. Child membership evidence
is recorded below.

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

## Foreground Agent family samples

`native-family-2.124.0/` contains five native JSONL files generated on macOS arm64
on 2026-09-12 UTC with CodeBuddy Code CLI 2.124.0, `--model hy3 --effort low`,
`-p --strict-mcp-config --setting-sources "" --max-turns 3`. The controlled parent
used `--tools Agent --allowedTools Agent`; custom leaf agents had no tools, and
the custom intermediate agent could call Agent. The built-in general-purpose
agent was prompted to return a literal marker and made no tool calls.

| Sequence | Root records | Child evidence | Projected totals |
| --- | --- | --- | --- |
| Initial custom `atape-fixture` delegation | 6 | `agent-6b64fa37`, three records | 2 Threads / 8 Events / 3 usage |
| Resume that same Agent via `resume` argument | 11 | Same child now six records; receipt `afterId` matches prior terminal response | 2 / 15 / 6 |
| Custom `atape-parent` delegates to `atape-leaf` | 16 | `agent-60a8b853`, six records; nested `agent-bc513377`, two | 4 / 27 / 11 |
| Parent manual `/compact` with tools disabled | 18 | Existing children unchanged | 4 / 29 / 12 |
| Built-in `general-purpose` delegation | 24 | `agent-64db2ff8`, three records | 5 / 37 / 15 |

The final fixture retains the exact relative source paths. Child storage IDs are
not their internal Session UUIDs. In particular the leaf file is below internal
parent UUID `e8142638-13cc-4138-95b5-c9283398cb11`, not `agent-60a8b853`.
The first child's receipt `lastId` points to reasoning preceding its completed
assistant message. This rules out using that receipt field alone as a cutoff.
Only the controlled absolute CWD was replaced with
`/fixture/codebuddy-family-project`; IDs, flags, timestamps, prompts, parent links,
receipts and usage are otherwise native. All five exact files were byte-verified
against scratch copies and removed from the CLI home after sampling.

Runtime and installed CLI contract fixtures replay the sequence using these
record boundaries. Adversarial child edits, foreign child CWD, truncation,
missing files, resource bounds and lost HTTP responses are controlled synthetic
variants. They establish failure/recovery behavior, not additional native forms.
Named teams, forks carrying children and child compaction have no native
acceptance evidence. Background evidence is recorded below.

## Background Agent samples

`native-background-2.124.0/` contains three native JSONL files generated on
2026-09-13 UTC on macOS arm64 with CLI 2.124.0, `--model hy3 --effort low`,
`-p --strict-mcp-config --setting-sources "" --output-format json`. The scoped
`CODEBUDDY_CODE_EXPERIMENTAL_AGENT_TEAMS=1` enabled the native automatic-team path.

| Sequence | Root records | Child evidence | Projected totals |
| --- | --- | --- | --- |
| One `atape-background` launch, `run_in_background: true`, then one `TaskOutput` | 9 | `agent-aeb3d60f`, three records | 2 Threads / 11 Events / 4 usage |
| Ordinary parent resume launches `atape-reporter` | 15 | `agent-93604b67`, six records including one SendMessage | 3 / 22 / 8 |
| Tools-disabled parent resume | 18 | Both children unchanged | 3 / 24 / 9 |

The first parent used `--tools Agent,TaskOutput --allowedTools Agent,TaskOutput`,
`--max-turns 5`, and a custom child with no tools. The second allowed
Agent/TaskOutput/SendMessage, but called only Agent; its custom child had only
SendMessage and sent one literal marker to the controlled local team-lead inbox.
The final parent used `--tools "" --max-turns 1`. No external recipient or personal
source history was involved.

Each spawn result carries a `team-member-spawned` renderer with JSON `taskId`,
`name`, `teamName`, `description`, `color` and `prompt`, without `subAgent.lastId`.
The child's first user message wraps the prompt in an exact `teammate-message`
initial assignment. Internal child UUIDs are respectively
`f8ac30c1-d2eb-4ceb-8f78-51b8223fd568` and
`f151ed56-1dbf-4b0f-aeb3-4fb1555c267e`; filenames retain their `agent-*` storage IDs.
All three exact source histories and controlled team files were byte-verified
against retained scratch copies and removed from the CLI home after sampling.
Only the controlled absolute CWD was replaced with
`/fixture/codebuddy-background-project`. All other fields, identities, timestamps,
relationships, prompts and counters are retained.

Observed intermediate snapshots had a completed spawn receipt and only the
child's initial user record; the first root's final reply preceded its child's
final reply. TaskOutput returned a running-team-member message. SendMessage
reported delivery into the controlled team-lead mailbox, but no parent inbox turn
was appended, including on the final parent resume. Tests must not invent one.
The native team config was recreated across parent resume, so current team files
cannot prove historical child membership. Snapshot cuts and adversarial changes
in tests establish atomic preservation, not additional supported native forms.

Installed acceptance replays these native boundaries, then applies synthetic
foreign child CWD, missing child, Raw policy edits and committed response loss.
Its recovery deletes all three source files and uses frozen Host data. The source
corpus has nine usage records: 74,371 input, 1,162 output and 43,072 cached input.
Cached input is already included in input. Named teams, inbox turns, multi-round
background work, child resume/nesting, disabled-team fallback and child compaction
remain unverified and unsupported.
