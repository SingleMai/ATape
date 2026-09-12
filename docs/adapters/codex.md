# Codex Adapter

`@atape/adapter-codex` collects project-scoped local Codex rollout files and projects their completed conversation items into ATape's ACP-centered Adapter protocol. The Adapter is an experimental compatibility layer: Codex documents the CLI product, but does not publish the local rollout JSONL layout as a stable integration API.

When Raw capture is enabled, unknown or newly introduced Codex records remain available in Raw while being omitted from Canonical until ATape can map them without inventing semantics. The Web conversation flow renders only Canonical events; it does not add “missing capability” placeholders for omitted provider records.

## Supported source and limits

Compatibility is exercised against the local rollout structure observed with
Codex CLI **0.150.1**; this is not a general support promise for every Codex release.
The Adapter reads local JSONL history and archived rollouts, including supported
root/subagent relationships. Unknown record types are omitted from Canonical;
Raw availability depends on the [capture policy](../cli/raw-capture.md).

The [discovery rules](#source-discovery-and-project-boundary) define accepted paths
and attribution. The [incremental contract](#incremental-and-raw-behavior) owns
record, cursor and page bounds. Source deletion preserves already captured
history; unsupported formats and missing attribution remain explicit diagnostics.

## Install and enable

From this repository, build and install the ready-to-run local package, then open
the console to add Codex to the global tool selection:

```sh
pnpm --filter @atape/adapter-codex build
pnpm atape adapters install ./adapters/codex
pnpm atape
pnpm atape start
```

For a packaged release, install the independently bundled Adapter instead:

```sh
atape adapters install "./atape-adapter-codex-<version>.tgz"
```

Choose **Tools and updates**, add Codex to the existing selection, and review the
affected Projects. Tool selection applies globally to connected Projects.
Replace `<version>` with the coordinated release version for offline installation.
Maintainers can build and smoke-test that artifact with `pnpm test:adapter-package`, or verify it together with the packaged CLI using `pnpm test:release`. Installing it does not start a process. The Collector Host imports it only while collecting configured Projects with Codex enabled.

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

Private reasoning content is not promoted into Canonical. When Raw capture is enabled, it remains part of the separately uploaded Raw source, subject to the Collector Host's client-side secret redaction.

## Incremental and Raw behavior

The Collector accepts empty pages that advance the cursor with `hasMore: true`,
such as finishing an already emitted phase or skipping a disappeared selection.
It commits traversal progress and continues within the cycle's page limit without
uploading an invented observation. Regression coverage verifies continuation,
stalled-cursor rejection, cycle bounds and recovery after later upload failures.
This requires an updated CLI; existing checkpoints need no reset. Other source
format limits and capture attribution rules remain unchanged.

The Adapter keeps no durable conversation cache. Its opaque cursor contains only a bounded Session watermark, a monotonic commit sequence, a last-completed Canonical Session marker, and an in-progress page snapshot. The snapshot freezes the selected provider title so pagination cannot emit different content at one Session revision. The commit sequence lets Raw-only changes such as archive finalization produce a new committed cursor even when the filesystem modification watermark is unchanged. The Collector's separate `rawProgress` checkpoint supplies acknowledged provider byte offsets.

When previously unknown Git history becomes attributable after the watermark has
passed it, unacknowledged sources complete Canonical before Raw. The optional
marker avoids repeatedly selecting the same Canonical recovery phase. Existing
v3 cursors remain readable; recovery may replay an idempotent Canonical observation
before its first Raw acknowledgement.

The title index is read as a bounded, tolerant compatibility source: only the most recent 16 MiB is considered, incomplete or malformed records are ignored, and collection continues with the root-prompt fallback when the file does not exist. A valid title record's `updated_at` participates in Session discovery and revision selection, so a title-only rename is collected without modifying Raw source. Cursor v3 resets v1 and v2 watermarks once and advances the Canonical projection revision so already captured Sessions can be replayed with provider titles even when the indexed title predates the latest rollout write.

- Active files are snapshotted only through their last complete newline-delimited record. A record being appended is deferred to a later cycle.
- File reads use 64 KiB blocks; one JSONL record and Adapter Raw segment may be at most 16 MiB. Canonical and Raw output are independently paginated by the Host's event, segment, and byte limits. Four-page work quanta rotate Sessions; a Raw quota prevents history starvation. After redaction, the Collector further divides a segment into server transport chunks of at most 3 MiB.
- Raw source objects use a stable filename-derived identity and a filesystem-derived generation. Moving an unchanged rollout from `sessions/` to `archived_sessions/` finalizes the same Raw generation.
- Completed per-file offsets skip already emitted Canonical records after appends. Changed file sets, generations or same-size rewrites reproject idempotently. Stable source Event IDs preserve existing records.
- Provider deletion is absence, not an ATape deletion signal. Already captured Canonical and Raw history remains on the server.

Fixture tests cover provider titles and renames, malformed title metadata, legacy Cursor backfill, root and subagent rollouts, copied-history filtering, Git worktree matching, incomplete active records, bounded pagination, Raw resumption, archival finalization, and provider deletion.

Tool titles remain bounded to 500 UTF-8 bytes after client-side redaction. A
replacement marker can expand a title that already reached that limit; the shared
Collector trims the redacted title at a character boundary and continues publishing
the observation and Raw data. Invalid oversized Adapter input is still rejected.

Large Codex Session snapshots use a bounded compressed cursor when plain JSON
would exceed the 16,000-byte limit. This permits supported Sessions with many
rollout files to resume without dropping files or resetting progress. Existing
checkpoints remain readable; compressed checkpoints require the updated Adapter.
See [ADR-0050](../architecture/adr/0050-bounded-compressed-codex-cursors.md).

Codex `history_mode: paginated` files have independent Git attribution identities
based on their stable rollout basename. Their shared Thread ID does not cause
new source timestamps to collide with the original file’s saved attribution.
Ordinary source bindings and Canonical identities are preserved; archival does
not change the paginated source identity. See [ADR-0051](../architecture/adr/0051-codex-paginated-source-attribution.md).

Within one runtime, continuation pages reuse the most recent Session projection
when its snapshot and source generation, size, and modification times still match.
A changed, missing, or replaced file invalidates it; only one projection is retained.
This avoids repeatedly parsing large unchanged files during historical backfill.

Continuation pages also refresh only the current Session's discovered source
paths. Each active source still rereads metadata and resolves current Git
attribution through the Host. Missing paths trigger full discovery; new files and
Sessions are found at the next Session boundary or four-page work quantum. A read-only benchmark against
the same real checkpoint reduced warm 500-event pages from 4.7–5.0 seconds to
0.25–0.28 seconds. This measures collection, excluding upload; initial discovery
and first projection of a large Session still take time. See
[ADR-0052](../architecture/adr/0052-active-session-collection-scans.md).

Both foreground and managed Collectors immediately continue a successful bounded
cycle when any job has more pages. The configured interval applies when caught
up or when a job fails. Source diagnostics alone do not pause eligible history.
Per-cycle page bounds, upload acknowledgement and cancellation remain unchanged.
Raw upload overlaps up to three independent objects and remains ordered within
each object. First projection of a changed Session still scans its captured files;
a persistent incremental projection index and negotiated transport compression
remain future optimization areas.

Per-Session completed/pending offsets retain older unfinished work when recent
conversations take priority. Cursor metadata has a 1 MiB encoded / 16 MiB decoded
bound; no payload or authorization result is stored there. Read/format/record-limit
failures retain progress and allow healthy Sessions to proceed; unchanged failed
sources retry after 60 seconds and changed sources become eligible immediately.

`atape status` reports the last completed cycle's acknowledged Canonical event
count, Raw transport bytes and duration, plus discovered source count and estimated
pending Canonical Sessions / Raw bytes. These are progress measurements, not a
promise that all source data has arrived. Inventory estimates refresh at discovery
and can include incomplete trailing records. See [ADR-0053](../architecture/adr/0053-large-archive-collection.md).

Short Session transitions now reuse discovery for up to four pages, with fresh
selected-source attribution. Title-index changes, missing sources and idle cached
inventories trigger complete discovery. Cached diagnostics are bounded discovery
observations; they never authorize source reads.

Projection v3 repairs cumulative item updates that previously collided across
pages or lost their later text within a page. It replays Canonical history once
with stable Event IDs and snapshot revisions; existing Raw acknowledgements
are retained. See [ADR-0055](../architecture/adr/0055-codex-item-update-revisions.md).

## Recovery and verification

Use Project details and `atape status --json` to distinguish queued history,
partial source coverage and transport failure. The [CLI recovery guide](../cli/setup-and-adapters.md#troubleshooting)
owns common recovery steps. Preserve Collector state and Git attribution evidence;
fix the reported source format or restore trustworthy attribution before retrying.
Deleting checkpoints cannot make an unsupported rollout format compatible.

Adapter tests exercise controlled source fixtures. `pnpm test:e2e` checks the real
CLI/Go boundary, and `pnpm test:adapter-package` / `pnpm test:release` check installed
artifacts and replacement recovery. These checks do not establish compatibility
with arbitrary older binaries, every Codex version or manual acceptance of a
new release candidate.

## Raw capture policy

This Adapter declares `atape.raw-capture.v1` and honors the host's
`rawCaptureEnabled` flag. Disabled Raw does not advance upload receipts;
Canonical continues and re-enabling backfills retained sources.
See [Raw capture configuration](../cli/raw-capture.md).
