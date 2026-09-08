# Codex Adapter

`@atape/adapter-codex` collects project-scoped local Codex rollout files and projects their completed conversation items into ATape's ACP-centered Adapter protocol. The Adapter is an experimental compatibility layer: Codex documents the CLI product, but does not publish the local rollout JSONL layout as a stable integration API.

Unknown or newly introduced Codex records therefore remain available in Raw while being omitted from Canonical until ATape can map them without inventing semantics. The Web conversation flow renders only Canonical events; it does not add “missing capability” placeholders for omitted provider records.

## Install and enable

From this repository, build and install the ready-to-run local package, then enable it for a configured Project:

```sh
pnpm --filter @atape/adapter-codex build
pnpm atape adapters install ./adapters/codex
pnpm atape adapters enable codex --project payments-api
pnpm atape start
```

For a packaged release, install the independently bundled Adapter instead:

```sh
atape adapters install ./atape-adapter-codex-0.1.0.tgz
```

Maintainers can build and smoke-test that artifact with `pnpm test:adapter-package`, or verify it together with the packaged CLI using `pnpm test:release`. Installing it does not start a process. The Collector Host imports it only while collecting a Project for which `codex` is enabled.

## Source discovery and Project boundary

The Adapter resolves the Codex data root in this order:

1. `ATAPE_CODEX_HOME`, intended for tests and explicit overrides.
2. `CODEX_HOME`.
3. `~/.codex`.

It scans `.jsonl` files below `sessions/` and `archived_sessions/` without following symbolic links. The first `session_meta` record identifies the rollout before the rest of the file is read.

For an ordinary-directory Project, the metadata `cwd` must resolve to the Project directory or one of its descendants. For a Git Project, the Adapter supplies original `session_meta` identity, CWD and any recorded Git remote to the shared Host attribution Module. Server repository identity and aliases determine membership across worktrees and independent clones. Path containment never includes a nested unrelated repository. Unknown identity produces an `attribution` source diagnostic; a known foreign repository is ignored. Git capture requires both the updated CLI and an Adapter declaring `atape.git-attribution.v1`.

The Host retains confirmed source evidence independently of the capture cursor.
Recorded or established remotes allow capture after the original directory is
deleted; without either, missing historical identity is reported rather than
guessed. See the [shared Git rules](../cli/setup-and-adapters.md#git-conversation-attribution).

## Session and subagent projection

- When `session_index.jsonl` contains a valid `thread_name` for the root Session ID, the latest record is used as the whitespace-normalized, bounded Session title. This preserves Codex-generated titles and later user renames. If that compatibility metadata is absent or malformed, the Adapter falls back to the first root-thread `UserMessage`, then to `Untitled Codex conversation`; provider Session IDs are never used as display titles.
- `session_meta.payload.session_id` identifies the logical ATape Session. When absent on a root rollout, `payload.id` is used.
- `session_meta.payload.id` identifies the Thread represented by that physical rollout file.
- Codex `thread_spawn.parent_thread_id` and `agent_nickname` establish the subagent parent and label.
- The Adapter emits one derived parent `tool_call` with `childSourceThreadId` for each discovered subagent Thread.
- A subagent rollout may contain copied parent history. Only `item_completed` events whose `thread_id` equals that rollout's own Thread ID become Canonical events, preventing copied history from appearing twice.
- A Session whose files are all under `archived_sessions/` is reported as `ended`; an unarchived Session is reported as open. ATape's read Modules present an open Session as `active` only for five minutes after its latest update and then age it to `idle` without rewriting Canonical history.

Completed Codex items map as follows:

| Codex item | ACP-centered Canonical update |
| --- | --- |
| `UserMessage` | `user_message_chunk` |
| `AgentMessage` | `agent_message_chunk` |
| `Reasoning.summary_text` | `agent_thought_chunk` |
| `CommandExecution` | `tool_call` with `execute` kind |
| `McpToolCall` | `tool_call` with `other` kind |
| `FileChange` | `tool_call` with `edit` kind |
| `ImageView` | `tool_call` with `read` kind |
| `Extension` | `tool_call` with `other` kind |

Private reasoning content is not promoted into Canonical. It remains part of the separately uploaded Raw source, subject to the Collector Host's client-side secret redaction.

## Incremental and Raw behavior

The Adapter keeps no durable conversation cache. Its opaque cursor contains only a bounded Session watermark, a monotonic commit sequence, a last-completed Canonical Session marker, and an in-progress page snapshot. The snapshot freezes the selected provider title so pagination cannot emit different content at one Session revision. The commit sequence lets Raw-only changes such as archive finalization produce a new committed cursor even when the filesystem modification watermark is unchanged. The Collector's separate `rawProgress` checkpoint supplies acknowledged provider byte offsets.

When previously unknown Git history becomes attributable after the watermark has
passed it, unacknowledged sources complete Canonical before Raw. The optional
marker avoids repeatedly selecting the same Canonical recovery phase. Existing
v3 cursors remain readable; recovery may replay an idempotent Canonical observation
before its first Raw acknowledgement.

The title index is read as a bounded, tolerant compatibility source: only the most recent 16 MiB is considered, incomplete or malformed records are ignored, and collection continues with the root-prompt fallback when the file does not exist. A valid title record's `updated_at` participates in Session discovery and revision selection, so a title-only rename is collected without modifying Raw source. Cursor v3 resets v1 and v2 watermarks once and advances the Canonical projection revision so already captured Sessions can be replayed with provider titles even when the indexed title predates the latest rollout write.

- Active files are snapshotted only through their last complete newline-delimited record. A record being appended is deferred to a later cycle.
- File reads use 64 KiB blocks; one JSONL record and Adapter Raw segment may be at most 4 MiB. Canonical and Raw output are independently paginated by the Host's event, segment, and byte limits. Changed Sessions complete their Canonical phase before Raw-only backlog is selected. After redaction, the Collector further divides a segment into server transport chunks of at most 3 MiB.
- Raw source objects use a stable filename-derived identity and a filesystem-derived generation. Moving an unchanged rollout from `sessions/` to `archived_sessions/` finalizes the same Raw generation.
- Canonical events may be replayed after a rollout changes. Stable source Event IDs and revisions make the server update the existing record rather than append a duplicate.
- Provider deletion is absence, not an ATape deletion signal. Already captured Canonical and Raw history remains on the server.

Compatibility is currently exercised against the local structure observed with Codex CLI `0.150.1`. Fixture tests cover provider titles and renames, malformed title metadata, legacy Cursor backfill, root and subagent rollouts, copied-history filtering, Git worktree matching, incomplete active records, bounded pagination, Raw resumption, archival finalization, and provider deletion.
