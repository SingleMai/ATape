# Codex Adapter

`@atape/adapter-codex` collects project-scoped local Codex rollout files and projects their completed conversation items into ATape's ACP-centered Adapter protocol. The Adapter is an experimental compatibility layer: Codex documents the CLI product, but does not publish the local rollout JSONL layout as a stable integration API.

Unknown or newly introduced Codex records therefore remain available in Raw while being omitted from Canonical until ATape can map them without inventing semantics. The Web conversation flow renders only Canonical events; it does not add “missing capability” placeholders for omitted provider records.

## Install and enable

From this repository, install the ready-to-run local package and enable it for a configured Project:

```sh
pnpm atape adapters install ./adapters/codex
pnpm atape adapters enable codex --project payments-api
pnpm atape collect --once --project payments-api
```

The package uses Node.js 24's type stripping and does not require a separate build step. Installing it does not start a process. The Collector Host imports it only while collecting a Project for which `codex` is enabled.

## Source discovery and Project boundary

The Adapter resolves the Codex data root in this order:

1. `ATAPE_CODEX_HOME`, intended for tests and explicit overrides.
2. `CODEX_HOME`.
3. `~/.codex`.

It scans `.jsonl` files below `sessions/` and `archived_sessions/` without following symbolic links. The first `session_meta` record identifies the rollout before the rest of the file is read.

For an ordinary-directory Project, the metadata `cwd` must resolve to the Project directory or one of its descendants. For a Git Project, the same path rule applies; a normalized `remote.origin.url` match is also accepted so Codex worktrees outside the primary checkout remain attached to the same ATape Project. Other sessions are ignored.

## Session and subagent projection

- `session_meta.payload.session_id` identifies the logical ATape Session. When absent on a root rollout, `payload.id` is used.
- `session_meta.payload.id` identifies the Thread represented by that physical rollout file.
- Codex `thread_spawn.parent_thread_id` and `agent_nickname` establish the subagent parent and label.
- The Adapter emits one derived parent `tool_call` with `childSourceThreadId` for each discovered subagent Thread.
- A subagent rollout may contain copied parent history. Only `item_completed` events whose `thread_id` equals that rollout's own Thread ID become Canonical events, preventing copied history from appearing twice.

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

The Adapter keeps no durable conversation cache. Its opaque cursor contains only a bounded Session watermark, a monotonic commit sequence, and an in-progress page snapshot. The commit sequence lets Raw-only changes such as archive finalization produce a new committed cursor even when the filesystem modification watermark is unchanged. The Collector's separate `rawProgress` checkpoint supplies acknowledged provider byte offsets.

- Active files are snapshotted only through their last complete newline-delimited record. A record being appended is deferred to a later cycle.
- File reads use 64 KiB blocks; one JSONL record and Adapter Raw segment may be at most 4 MiB. Canonical and Raw output are independently paginated by the Host's event, segment, and byte limits. After redaction, the Collector further divides a segment into server transport chunks of at most 256 KiB.
- Raw source objects use a stable filename-derived identity and a filesystem-derived generation. Moving an unchanged rollout from `sessions/` to `archived_sessions/` finalizes the same Raw generation.
- Canonical events may be replayed after a rollout changes. Stable source Event IDs and revisions make the server update the existing record rather than append a duplicate.
- Provider deletion is absence, not an ATape deletion signal. Already captured Canonical and Raw history remains on the server.

Compatibility is currently exercised against the local structure observed with Codex CLI `0.150.1`. Fixture tests cover root and subagent rollouts, copied-history filtering, Git worktree matching, incomplete active records, bounded pagination, Raw resumption, archival finalization, and provider deletion.
