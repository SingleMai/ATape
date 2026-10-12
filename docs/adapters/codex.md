# Codex Adapter

`@atape/adapter-codex` collects project-scoped local Codex rollout files and projects their completed conversation items into ATape's ACP-centered Adapter protocol. The Adapter is an experimental compatibility layer: Codex documents the CLI product, but does not publish the local rollout JSONL layout as a stable integration API.

When Raw capture is enabled, unknown or newly introduced Codex records remain available in Raw while being omitted from Canonical until ATape can map them without inventing semantics. The Web conversation flow renders only Canonical events; it does not add “missing capability” placeholders for omitted provider records.

For a local build or release tarball, use Tools and updates → Integration maintenance
to install its directory or full archive path, then Choose tools to sync.
The current tool and file-activity increment uses Canonical v5 and a v7 cursor. It has not
been published or deployed: published 0.5.10 uses Canonical v3 and its projection-v5
cursor. A supporting Server and complete CLI/Adapter bundle are required for
the checkout revision; see [coordinated upgrades](../cli/setup-and-adapters.md#stable-native-tool-identity-checkout-increment).

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
pnpm atape
```

For a packaged release, install the independently bundled Adapter instead:

```sh
atape
```

Choose **Tools and updates**, add Codex to the existing selection, and review the
affected Projects. Tool selection applies globally to connected Projects.
For offline installation, enter the release Adapter tarball path in Integration maintenance.
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

## Stable native tool facts

Current Canonical v5 capture records explicit native `function_call` and
`custom_tool_call` names as ordinary tool identities. The closed native item
types `CommandExecution`, `FileChange` and `ImageView` supply those stable names;
their original command or display title remains separate. Native `McpToolCall`
server/tool fields supply an MCP identity. Extension labels, shell text and
missing or invalid names do not establish an identity. Derived child spawn
markers likewise remain without an inferred native tool name.

Names must be trimmed, well-formed Unicode and fit 500 UTF-8 bytes. Identity
absence preserves the preceding fact on the same call; explicit null clears it.
Explicit outcomes retain their existing meaning. The Adapter retains admitted
original MCP `server`/`tool` fields so upload field rules can hide their copied
identity and display values. The Host applies existing identity, copied-name and
payload redaction before delivery; grouping rules belong to the Server's
[Session Analytics Module](../session-analytics.md#stable-tool-grouping).
See [ADR-0124](../architecture/adr/0124-stable-native-tool-identity.md).
File activity uses only explicit typed source fields described below.

## Explicit file activity

The unpublished Canonical v5 contract carries bounded typed path facts in
`atape.dev/file-activity`, separately from tool identity and display title:

| Native item | Recorded paths | Meaning |
| --- | --- | --- |
| `CommandExecution` | `parsed_cmd[].path` for exact native `read` / `search` types | Read targets or search scopes; one call can carry both. |
| `FileChange` | Keys of `changes` with `add`, `update` or `delete` types, plus explicit `move_path` destinations | Reported edit targets; failed status does not establish a successful change. |
| `ImageView` | `path` | Image read target. |

Repeated operation/path pairs are counted once per folded call. Search scopes
are not matching files. The Adapter keeps the complete bounded original
`parsed_cmd`, `changes` or `path` input so the Host can honor copied-field
redaction, including object keys. No shell command, old `apply_patch` envelope,
function argument, MCP input or result text is classified into file paths.

Paths retain their original spelling without resolution or normalization.
Invalid Unicode, controls, empty paths, paths above 2,048 UTF-8 bytes, source
inputs outside the shared 64 KiB admission, or path sets above 64 entries or
4,096 JSON UTF-8 bytes explicitly clear the complete activity fact with null. Facts are never truncated
into partial paths. An empty native collection can explicitly clear an earlier
fact; it does not prove no file was touched. Complete native updates with missing path fields also clear old facts with null;
unrelated updates omit the field and preserve earlier facts. Null remains unknown.
Upload masking of a path or its original input clears the copied activity fact.
Image-view display titles use the generic `View image` so a hidden source path
cannot survive as a copied basename.

Cursor/projection v7 reads complete v5 and v6 state, preserves source ranks,
revision floors and Raw receipts, and replays available Canonical history once.
Older Adapters cannot read the new v7 cursor; recover forward without resetting
state. Published 0.5.10 has neither this projection nor file activity support.

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

Project → Sync details reports the last completed cycle's acknowledged Canonical event
count, Raw transport bytes and duration, plus discovered source count and estimated
pending Canonical Sessions / Raw bytes. These are progress measurements, not a
promise that all source data has arrived. Inventory estimates refresh at discovery
and can include incomplete trailing records. See [ADR-0053](../architecture/adr/0053-large-archive-collection.md).

Short Session transitions now reuse discovery for up to four pages, with fresh
selected-source attribution. Title-index changes, missing sources and idle cached
inventories trigger complete discovery. Cached diagnostics are bounded discovery
observations; they never authorize source reads.

## Source clock quality and replay

The current Codex paged runtime explicitly declares
`legacyCanonicalProfile: "atape.acp-centered.v5"`. Its factory requires explicit
v5 Host support and defers source opening until collection. Collection requires
affirmative Server Canonical v5 support before reading source bytes or advancing
checkpoint/Raw progress. New CLI discovery explicitly opts into v5; default
Server discovery retains v2/v3/v4 for published clients. The published 0.5.10
Host/Server do not support this revision, which has not been published or
deployed. See [v5 ingestion](../api/canonical-ingestion.md#v5-stable-native-tool-identity) and
[the package contract](package-manifest.md#paged-observation-runtime-export).

The earlier nullable-clock transition from published 0.5.9 to 0.5.10 declared
legacy Canonical v3. Its first managed update with active Codex collection
was rejected during read-only
preflight, before the Collector is paused. The older parent does not bind the
new manifest capability into the same scope as the target. This applies even
when both runtimes use the unchanged capture-state contract. Stop sync before
upgrading the CLI and matching Adapter bundle; retain checkpoints and Raw
acknowledgements. The required POSIX release gate executes the genuine published
0.5.9 console's stopped complete-bundle handoff to the exact 0.5.10-or-later
candidate, then real installed target Collector replay, no-op and append cycles.
It verifies preserved configuration, credentials, checkpoint bytes, Raw receipts
and Stop intent through the caller Interfaces, with Instance minimum CLI 0.5.10
during upgrade. Distribution and Server HTTP are owned external Test Adapters;
the controlled source records do not establish live Provider acceptance or an
upgrade of a personal installation. Follow the
[stopped Codex upgrade](../cli/setup-and-adapters.md#codex-source-clocks-059-to-0510).
Other older-parent boundaries remain governed by the
[upgrade guide](../cli/setup-and-adapters.md#upgrade-the-cli-and-adapters).

Supported records with missing, null or invalid source timestamps remain
captured with `occurredAt: null`. Session `updatedAt` is the maximum admitted
source clock in its selected frozen metadata/title/record snapshot, or null.
Filesystem modification time supports discovery, revision and the stable legacy
observation/Raw capture basis; it never fills Session or Event occurrence clocks.
Retrying an unacknowledged Raw chunk reconstructs the same capture metadata.
Derived spawn clocks use available child
metadata or null, and their order fidelity is derived. Ordering records in one
JSONL file follows physical byte order even when clocks are missing or reversed;
ordering separate files in one Thread is derived. A bounded, persisted per-Session
source-object/generation registry gives each file generation a disjoint numeric namespace and each record its
byte-offset coordinate. Append and discovery reordering preserve coordinates;
removed files retain their ranks so later files cannot reuse them. Capacity
exhaustion fails explicitly rather than folding distinct records together.

Released projection v5 established source-clock correction and once-only replay
of supported older Canonical cursors. Current projection v7 inherits that clock
behavior and replays available older projections to add explicit tool identities and typed file activity
with stable Event IDs and a higher revision floor, including old active
Canonical/Raw pages and completed progress. Saved Raw acknowledgements are
retained. Later pages freeze
Session source recency and title at that revision. Unavailable source history
cannot be repaired; previously accepted epochs are not guessed away by the
Server. Keep checkpoints and use the updated Adapter for forward recovery;
older Adapters, including published 0.5.10, cannot read the new v7 cursor. The
earlier projection-v5 cursor refusal remains part of the 0.5.9-to-0.5.10 clock
transition evidence; it does not establish v7 rollback compatibility.

First projection of a changed snapshot makes an additional bounded record scan
to compute source recency after final ownership/format selection. Continuations
reuse the bounded projection cache. This legacy path does not acquire frozen
sourceCapture recovery or complete-target publication merely by changing its
Canonical profile. Existing uncertain-delivery and redaction-policy constraints
continue to apply. [ADR-0122](../architecture/adr/0122-explicit-legacy-source-clocks.md)
records the choice and alternatives.

Current projection v7 retains projection v5's clock correction and v4's
cumulative item repair described in
[ADR-0055](../architecture/adr/0055-codex-item-update-revisions.md) and preserves
unknown tool outcomes. A missing or unrecognized provider status is omitted;
it does not mean success or failure. Explicit provider outcomes and numeric
command exit codes remain authoritative. Upgrading a projection v3 checkpoint
replays Canonical history once with stable Event IDs and higher projection
revisions; existing Raw acknowledgements are retained.

The derived child-Thread spawn marker remains `completed`: observed child
metadata proves the spawn occurred. This describes creation of the child, not
successful completion of its delegated work. Native image-view and extension
items follow their explicit status; their presence alone does not establish an
outcome.

## Recovery and verification

Use Project → Sync details in ATape to distinguish queued history,
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
