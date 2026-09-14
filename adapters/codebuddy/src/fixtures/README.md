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

Pre-message LLM summaries, pruning/rewind and manual/pre-message child compaction
have no native acceptance sample here. Emergency evidence is recorded below.

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
Cached input is already included in input. Continuation evidence follows below.
Named teams, generic inbox turns, nested background delegation, disabled-team
fallback and child compaction remain unverified and unsupported.

## Background continuation samples

`native-background-turns-2.124.0/` contains two native histories generated on
2026-09-13 UTC on macOS arm64 with CLI 2.124.0, `--model hy3 --effort low`,
`-p --strict-mcp-config --setting-sources ""`, and scoped
`CODEBUDDY_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. The custom `atape-continuation`
child had no tools and replied only with controlled literal markers.

A persistent `--input-format stream-json --output-format stream-json` parent
process allowed only Agent and SendMessage (`--max-turns 4`). Its first prompt
requested one background launch. After its child completed, the second input
requested one SendMessage to that member. Closing stdin after both replies let
the native parent process its framework inbox. A separate process then used
ordinary `--resume`, allowed only Agent, and requested a foreground Agent resume
of the existing storage ID (`--max-turns 3`). No external recipient was involved.

| Snapshot boundary | Root / child records | Projected totals |
| --- | --- | --- |
| Initial completed launch | 6 / 3 | 2 Threads / 8 Events / 3 usage |
| Completed serial SendMessage | 11 / 6 | 2 / 15 / 6 |
| Native reactivation and completion notices | 15 / 6 | 2 / 17 / 7 |
| Foreground resume after CLI restart | 20 / 9 | 2 / 24 / 10 |

The child remains `agent-6004ad24`, with internal UUID
`c1782681-ecb5-4124-83e6-4b12c4a8b743`. The SendMessage receipt has no child ID or
turn boundary; its structured routing, earlier unique spawn name and exact next
child wrapper jointly prove membership. The call timestamp follows the prior
terminal response. The foreground resume receipt's `afterId` equals the second
terminal ID; `lastId` points to third-turn reasoning before the completed reply.
This third user prompt is plain text, unlike the two earlier team-lead wrappers.

Root records 12 and 13 (one-based) carry native `providerData.teammateMessage`
metadata and exact reactivation/completion templates. They have no Canonical
Events or invented usage. The following native assistant thought/reply remains
visible. The ten usage records total 100,306 input, 801 output and 74,880 cached
input; seven belong to the parent and three to the child. Cache is part of input.

Only the controlled CWD was replaced with
`/fixture/codebuddy-background-turns-project`. All other fields, IDs, timestamps,
wrappers, notifications, receipts and usage are native. Both histories were
byte-verified against retained scratch copies and removed from the CLI home;
the exact controlled automatic-team files were also backed up and removed.

Tests replay these boundaries and derive adversarial pending/missing turns,
mismatched routing/renderer/wrapper, unknown or duplicate recipients, broadcasts,
overlap, invalid resume receipts and unknown framework metadata/body/status.
Installed acceptance adds foreign child CWD, Raw policy changes, a synthetic
completion-duration edit, committed HTTP response loss and deletion of both
source files. These mutations establish preservation and recovery guarantees;
they are not additional native feature claims. Generic inbox messages, concurrent
message batching and background-flag resume remain outside this evidence.

## Emergency compaction samples

`native-emergency-2.124.0/` contains two native JSONL histories generated on
2026-09-13 UTC on macOS arm64 with CLI 2.124.0, `--model hy3 --effort low` and
`-p --strict-mcp-config --setting-sources "" --output-format json`. A custom
`atape-compact` foreground child first had no tools, then only Read, then no
tools on the final resume. The parent allowed Agent (and Read only during the
controlled file scenarios); it called only Agent. Pre-message compaction was
disabled in all four runs because the native interceptor excludes subagents.

| Sequence | Root / child records | Projected totals |
| --- | --- | --- |
| Marker-only foreground launch | 6 / 3 | 2 Threads / 8 Events / 3 usage |
| Resume; Read rejects 600 lines; root emergency compacts | 14 / 8 | 2 / 18 / 7 |
| Resume; Read 300 lines; child emergency compacts and continues | 20 / 18 | 2 / 31 / 12 |
| Marker-only resume after compaction | 25 / 21 | 2 / 38 / 15 |

Emergency triggers used process-scoped `CODEBUDDY_AUTOCOMPACT_PCT_OVERRIDE=5` for
the second run and `10` for the third; the final run used `100`. Root turn limits
were three/four/four/three, and child call limits one/four/four/one. The controlled
file contains generated marker lines, with no personal data. The first Read
reported 33,300 estimated tokens above its 20,000-token limit. The later 300-line
Read succeeded but spilled its large output. After native compaction, the child
called Read again and returned its marker. Both calls, their recorded spill
placeholders and the earlier failed Read are retained. The external spill files
are not fixtures or Adapter inputs.

The child remains `agent-1fc648c0` with UUID
`5167c3b9-23a8-4593-8ba2-4dd5185a574e`. Native foreground receipts keep the
`afterId` chain; `lastId` points to reasoning before the terminal assistant.
Root records 11–12 and child records 12–13 (one-based) are emergency summary and
continuation pairs, connected through `logicalParentId`. The native child
continuation uses the current delegated prompt's first 200 JavaScript code units
plus `...`. Those four internal records have no Event or usage. Real replies,
thoughts and tools before and after compaction remain in their original Threads.

The corpus has 15 normalized model responses: eight parent and seven child,
totaling 151,085 input, 1,795 output and 75,840 cached input. The separate
`runOneTime` summary calls do not persist normalized usage in these JSONL
histories, so these totals describe the stored responses rather than all spend.

Only controlled absolute paths were normalized: CWD/prompt paths to
`/fixture/codebuddy-child-compact-project-000000000000000` and recorded spill
locations to `/fixture/codebuddy-home/projects/controlled-child-compact`.
The CWD replacement deliberately preserves length so the native 200-code-unit
intent excerpt remains exact. IDs, flags, summaries, record boundaries and
counters are otherwise native. Two histories and two controlled spill files were
byte-verified against retained scratch copies and removed from the CLI home.

Runtime tests replay native boundaries and derive incomplete summaries, malformed
continuation text, wrong intents/links/flags, unexpected context usage and extra
human turns. Installed contract relocation adjusts the native intent excerpt to
the relocated controlled prompt and supplies a foreign child CWD; these are
synthetic attribution inputs. Raw policy edits, source deletion and lost HTTP
responses test recovery rather than additional native formats.

## Ordinary multi-tool sample

`native-multitool-2.124.0.jsonl` was generated on 2026-09-13 UTC (2026-09-14
Singapore time), macOS arm64, CLI 2.124.0. Three independent invocations used
`-p --strict-mcp-config --setting-sources "" --model hy3 --effort low
--max-turns 4 --tools Read --allowedTools Read --output-format json`, with
`PRE_MESSAGE_COMPACT=0` and `CODEBUDDY_AUTOCOMPACT_PCT_OVERRIDE=100`. The first
created `atape-codebuddy-multitool-21240`; the other two resumed it normally.

The first prompt requested a seed marker without tools. The second requested
Read of two controlled marker-only files in the same response. Both calls
completed and the assistant returned the pair marker. The third requested a
resume marker without tools. Captured boundaries are 4, 11 and 14 JSONL records
(3, 9 and 11 Events respectively). A runtime test also reads the seven-record
prefix to verify that the first tool call's existing identity survives the
second sibling's arrival.

One-based records 7 and 8 share `id=7b50079b29654d3684c42cafc72ed0ef` and
`parentId`, with distinct `callId` and the same model response. Only record 8
carries normalized usage; records 9 and 10 contain the matching results with
separate IDs. The four usage samples total 28,477 input, 145 output and 21,376
cached input. Only the controlled absolute CWD and file paths were replaced with
`/fixture/codebuddy-multitool-project`; all other native fields are retained. The controlled source was byte-verified
against its retained scratch copy and removed from the CLI home.

Derived tests mutate parent/Session/model identities, repeat or revise calls,
interrupt the group, change results, attach early usage and substitute delegation.
Installed acceptance additionally changes Raw policy, adds a Raw-only field to
the second sibling, drops committed HTTP responses and deletes the source. These
are fault and recovery inputs, not additional native format evidence.

## Forks with copied foreground children

`native-fork-family-2.124.0/` contains eight controlled files: three root JSONL
histories, two fork sidecars and three child JSONLs. They were generated on
2026-09-13 UTC (2026-09-14 Singapore time), macOS arm64, CLI 2.124.0. Eight print-mode
invocations used `--strict-mcp-config --setting-sources "" --model hy3 --effort low
--max-turns 3 --tools Agent --allowedTools Agent --output-format json`, with
`PRE_MESSAGE_COMPACT=0` and `CODEBUDDY_AUTOCOMPACT_PCT_OVERRIDE=100`. The custom
`atape-fork-child` has no tools; `atape-fork-parent` allows only Agent. Only the
requested marker delegations were performed in an otherwise empty scratch directory.

| Native action | Stored result |
| --- | --- |
| Create original root and foreground child | root 6 rows; `agent-97ab43b2` 3 |
| Fork original root; tool-free marker | simple fork 9 rows; child file unchanged |
| Resume original child | original root 11; same child 5; simple fork unchanged |
| Resume simple fork without tools | simple fork 11; captured child remains first 3 rows |
| Original root delegates a parent which delegates a leaf | original root 16; `agent-d40e1747` 5; `agent-375d1c88` 3 |
| Fork the original root again | three-level fork 19; child files unchanged |
| Resume the original parent and leaf | original root 22; parent 9; leaf 5; fork unchanged |
| Resume the three-level fork without tools | three-level fork 21; captured parent/leaf remain 5/3 |

Both forks have `forkedFrom: atape-codebuddy-fork-child-root-21240`. No child
files were copied by the CLI. Direct children remain under that original root's
`subagents` directory; the leaf is under its parent's UUID
`dc73f83c-3107-474d-bb1e-13952cff1643`. The simple fork selects only the first turn
of `agent-97ab43b2`; the later fork legitimately copies both of its turns. Later
original parent/leaf turns are excluded independently. The first direct child
and leaf receipts name reasoning before their terminal assistant; those assistant
answers must remain present.

The simple resumed fork contains 12 Events and five usage samples: 39,864 input,
177 output, 19,136 cache. The three-level resumed fork contains 30 Events and 13
usage samples: 98,806 input, 577 output, 56,896 cache. Copied responses represent
captured history, not new spend. Only the controlled absolute CWD was replaced
with `/fixture/codebuddy-fork-family-project`; all other fields, sidecars and IDs
are native. All eight native source files were byte-verified against retained
scratch copies before removing their owned CLI project bucket.

Derived tests delete selected children, truncate the receipt boundary, change
prompts/parents, append unfinished original turns and attempt new delegation
after the fork. Installed acceptance rewrites CWDs to prove fork-owned attribution,
uses the actual installed CLI for initial capture, original growth and parent
resume, mutates Raw policy/content, drops committed HTTP responses and deletes
all five installed sources. The original root JSONL is absent throughout that
installed contract. These mutations prove attribution and recovery, not additional
native formats or support for delegation launched from a fork.

## New foreground children from forks

`native-fork-new-2.124.0/` contains seven controlled files generated on
2026-09-14 (Asia/Singapore; 2026-09-13 UTC) with CodeBuddy Code CLI 2.124.0 on
macOS arm64. The commands used `-p --strict-mcp-config --setting-sources ""`,
`--model hy3 --effort low --max-turns 3 --tools Agent --allowedTools Agent`,
`PRE_MESSAGE_COMPACT=0` and `CODEBUDDY_AUTOCOMPACT_PCT_OVERRIDE=100`.
`atape-fork-child` permits no tools; `atape-fork-parent` permits only Agent.
The prompts request literal markers and exactly one foreground delegation.
Only the controlled physical CWD was normalized to
`/fixture/codebuddy-fork-new-project`; all record IDs, timestamps and usage remain
native. Research commands and stdout stay outside the repository.

| Native command sequence | Durable rows |
| --- | --- |
| New original root and seed child | root 6; seed `agent-203ccf33` 3 |
| `--resume <root> --fork-session --session-id <fork>`, create new child | fork 12; `agent-638af8c5` 3 under the fork ID |
| Ordinary `--resume <fork>`, create parent and leaf | fork 16; `agent-70af9d40` 6 under the original root ID; leaf `agent-dc98c023` 3 |
| Resume seed child from original root | original 11; seed 6; fork unchanged |
| Ordinary fork resume without tools | fork 18; all children unchanged |

The root is `atape-codebuddy-fork-new-root-21240`, fork is
`atape-codebuddy-fork-new-copy-21240`, and the sidecar names the original root as
`forkedFrom`. The leaf is stored under its parent's UUID
`5702d032-198a-4536-a9ce-caca5b89ae8e`. The initial fork turn carries the fork ID;
subsequent ordinary fork turns carry the restored original root ID. Installed
`SessionMiddleware.forkSession` copies only root history, while native child
creation uses `mainSession.id` as `parentSessionId`; the path combines that ID
with the child's storage ID. The samples prove both directory forms.

The fork retains only the seed's first three rows, excluding
`ATAPE_FORK_NEW_ORIGINAL_LATER_21240`. It includes every row of its new children.
Initial, nested-complete and final views contain respectively 16/29/31 Events,
6/11/12 usage records and 3/5/5 Threads. The final normalized totals are 87,179
input, 659 output and 53,248 cache tokens. Root/seed/first-new/parent/leaf usage
counts are 7/1/1/2/1. Parent receipts often name reasoning; the following completed
assistant remains visible. No child was resumed from the fork in this corpus.

Runtime negative cases alter only controlled fixtures to test missing/wrong paths,
pending responses, prompt/receipt mismatch, extra unaccounted turns, unsafe path
segments and unsupported child continuation. Installed acceptance changes only
CWDs and deliberate fault/Raw-policy markers, deletes the original root JSONL,
and exercises frozen recovery after deleting all six selected source files.
