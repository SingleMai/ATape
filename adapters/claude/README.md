# Claude Code Adapter

Discover Project-scoped Claude Code JSONL Sessions through ATape's normal
Collector, shared ACP profile, server and existing conversation page.

```sh
pnpm --filter @atape/adapter-claude build
pnpm atape
```

In **Tools and updates**, add Claude to the existing global selection and review
the affected Projects. Installing an Adapter alone does not enable collection.
In Tools and updates, use Choose tools to sync;
tool selection applies to every connected Project.

For an offline packaged installation, `pnpm pack:release` produces the CLI and
official Adapter tarballs plus `SHA256SUMS` under `release/`. Install the matching CLI
tarball, then install the Claude Adapter tarball path in Tools and updates → Integration maintenance.
These local build commands do not publish to npm or deploy an instance.

The Project must already be configured and authenticated normally. Discovery reads
`~/.claude/projects/*/*.jsonl`; set `ATAPE_CLAUDE_HOME` to an absolute alternate
Claude configuration directory when needed. `ATAPE_CLAUDE_SESSION_FILE` remains
an optional absolute single-file override, useful for controlled capture or
diagnosing a file outside the discovery profile.

A discovered file is not permission to upload it to an unrelated Project: its
original root CWD must belong to the configured ordinary directory, or the shared
Host must match its original Git remote to the configured Project. Git matching
includes linked worktrees and independent clones and excludes nested unrelated
repositories. Later `/cd` values do not reassign a Session. The Host preserves
confirmed evidence across origin changes and directory deletion; an unavailable
original directory without established evidence is reported as `attribution`.
Both CLI and Adapter must support `atape.git-attribution.v1` for Git capture.

## Supported now

- Automatic discovery under enabled Projects. Directory names do not determine
  attribution. Discovery inspects up to 256 records / 64 MiB per file for the first UUID record
  and checks its original CWD before streaming the Session. Symlinked
  files/directories are not traversed. Ordinary foreground child files are read
  only after the root proves their relationship; other subagent directories are
  not recursively scanned.
- One changed Session per page, with round-robin scanning and per-Session progress
  in the existing Collector checkpoint. Reopening the Adapter preserves progress;
  unchanged Sessions are not re-uploaded. New files and appends are discovered on
  subsequent collections. Moving a file does not create a new Session; missing
  files retain their checkpoints and captured history. Existing single-file v1
  checkpoints are carried forward without resetting their committed prefixes.
- A root with append-only local history, the narrow manual compaction profile
  below and proved ordinary foreground
  child streams, all with valid UTF-8 JSONL. A correlated successful `Agent` or
  `Task` result's `toolUseResult.agentId` selects the child at
  `<root-file-directory>/<sessionId>/subagents/agent-<agentId>.jsonl`. Admission
  requires status `completed`, no asynchronous/error result and exact
  `sourceToolAssistantUUID` correlation. The child's first record must agree
  with the root Session ID and original CWD and declare the selected Agent ID
  and `isSidechain: true`. The `.meta.json` sidecar is not read. The child becomes `claude-agent:<agentId>` below `root`,
  linked from the real parent tool-result Event. The root's original attribution
  owns this family; directory location or a child CWD does not authorize it.
- User/assistant text, tool call/status summaries and bounded tool input/output.
  The shared reader displays Input/Output in collapsed, escaped text/JSON details.
  Correlation IDs link call and result within their Session/Thread. Host redaction
  runs before Canonical encoding; null, false, zero and empty values stay distinct
  from absence. Values beyond 64 KiB / depth 32 / 10,000 nodes remain only in Raw.
  Unknown contents and nonempty thinking also remain Raw. Tool-bearing projections
  retain their conservative partial status; this is not complete ACP content support.
- Stable record UUID + physical block-slot Event identities; replay does not
  duplicate messages. Same-model-message split records remain distinct.
- Complete-line eligibility, bounded record pagination and existing
  Host secret redaction before Canonical/Raw network requests.
- Stable appendable Raw objects and per-record Canonical progress. Appends send
  only new records; large text records split across bounded Canonical pages.
  Existing immutable Raw snapshots remain available after checkpoint migration.
- Independent child prefix verification, Canonical pagination and Raw progress.
  The version-2 discovery cursor adds optional child metadata while retaining
  version-1 single-file and existing version-2 recovery. Existing root Session,
  Thread, Event and Raw keys are preserved. Missing child sources retain captured
  history and their committed checkpoints.
- Native manual root `/compact` on Claude Code 2.1.263, retaining the original
  byte prefix and visible conversation before appending real continuation turns.
  A null-parent `compact_boundary` must explicitly name the current last UUID
  as its logical parent; both preserved-segment endpoints and the single
  preserved-message UUID must name that same tail. The preserved anchors select
  the next user-shaped summary, which must have `isCompactSummary` and
  `isVisibleInTranscriptOnly` set. A strict checkpointed state machine accepts
  the native summary → caveat → `/compact` command → stdout → zero-token
  `<synthetic>` `No response requested.` bridge chain. These internal controls
  stay Raw-only; real turns afterward use the existing root Thread. The summary
  is actually loaded by the model, but is not attributed to the user in Reader
  or Search. An unfinished stage waits for the remaining source append; a
  conflicting edge or marker is unsupported. The existing projection revision
  4 and root/child identities remain unchanged.

## Explicit limits

No automatic compaction, cross-file continuation, larger preserved segments,
copied UUID replay, child compaction, branching/rewind, background or nested subagents,
interrupted child runs, child forks or spill collection in this increment.
Foreground parentage is fixed before publication; there is no implicit reparenting
or atomic family replacement. Ambiguous graphs, changed committed prefixes,
corrupt checkpoints and JSONL records exceeding 16 MiB are isolated explicitly.
Root pages are drained first; sustained root backlog can delay child capture.
Admitted children rotate between pages once the root is caught up.
Whole Session size and total record count are no longer limited to 4 MiB / 10,000.
Each observation honors the Host's 500-event / 3 MiB Canonical budget and 16 MiB
Raw budget. Root/child Thread headers, including each newly admitted child, are
reserved before filling Canonical pages. Text fragments are at most 256 KiB; smaller requested budgets fail
explicitly if one record or fragment cannot fit. Prefix hashing detects edits to
already captured bytes; a changed file requires streaming those bytes again for
integrity, while parsing and publication resume at the saved record position.
Discovery scans at most 10,000 directory entries. Metadata-only cursors are
compressed above 16,000 bytes, with a 1 MiB wire / 16 MiB expanded bound. Capacity
errors retain committed progress. Only sources with readable identity
and original CWD in their bounded header are automatically attributable; use the
single-file override to diagnose malformed or unrecognized headers. An unsupported
attributed source is isolated without marking it captured; other sources continue.
Multiple files claiming the same Session identity are all isolated rather than merged.

## Partial collection

Automatic discovery reports source read/format errors, unsupported histories,
changed prefixes, oversized records and duplicate identities as local
`sourceFailures`. Unattributable headers are diagnosed locally; unrelated bodies
are not uploaded. Healthy Sessions still advance; failed Sessions retain their
committed progress and are retried next cycle. Repair a malformed source or restore
its exact captured prefix to resume it. Unsupported history needs a future Adapter
capability, not a cursor reset. No automatic deletion or permanent quarantine occurs.

Project → Sync details includes the diagnostics for partial
collection. Text output lists escaped source paths and generic reasons; the Host
masks configured secrets. Project status shows `partial` and continues
collecting. Reports retain up to 32 distinct diagnostics with a truncation flag,
not an exact count of all failed files. A clean cycle clears previous diagnostics.
Global discovery/cursor capacity, corrupt checkpoints and Host/transport failures
still fail the job. The single-file override stays fail-fast except that unknown
Git attribution is reported as partial coverage. Update the Host and
Adapter together to retain the new optional diagnostic fields.

The legacy Host's source-mutation/concurrent-writer and lost-checkpoint
recovery limitations still apply. Use a single Collector and preserve its state.
No new SQLite journal or provider-specific page is installed. Bounded shared tool
details ship under ADR-0030; full ACP content, generation tokens and atomic
publication remain deferred.

Manual compaction is additive, not complete Active Path replacement. Its
boundary, summary and controls are captured only when Raw is enabled; no
ordinary user/assistant Event is fabricated for them. Filtering applies only
inside the admitted native state machine, and ordinary records outside it retain
their existing projection. The compaction model response has no assistant record
in the native JSONL, so that request's actual token usage cannot be recovered.
`compactMetadata` counts are context bookkeeping, not usage; synthetic zero
counters do not create a usage item. Recorded real assistant usage continues
normally. A future replacement profile requires explicit legacy migration;
changing the manifest or clearing a cursor would not preserve capture.

## Upgrade order

Deploy the updated server (including migration 000010) before the updated CLI and
Adapter. The CLI emits `atape.acp-centered.v2`; the server still accepts v1
without tool details. Preserve Collector state. Supported checkpoint upgrades
retain root Event IDs and verify committed source prefixes; they do not invent
new Sessions. Projection revision 4 reprojects earlier supported root checkpoints
once to discover foreground receipts. Finish pending
old-client collection retries before upgrading other Adapters; this slice does
not add a general cross-profile recovery protocol. No package is published by
the development build commands above.

A package-version change alone no longer blocks recovery: the installed Adapter
decodes the persisted cursor schema and revalidates captured bytes. Unknown cursor
formats and changed prefixes still stop/diagnose the affected capture, never reset
it. Preserve the complete CLI state directory, upgrade through Tools and updates,
and inspect Project → Sync details afterward. This is not a promise of old Claude
source-format compatibility; a future breaking cursor format must provide its own
explicit migration or rejection. See [ADR-0032](../../docs/architecture/adr/0032-claude-release-and-recovery.md).

`fixtures/native-read-2.1.263.jsonl` retains decoded records from a real, controlled
Claude Code 2.1.263 invocation, with home/temporary paths substituted. It is not
byte-identical original Raw and contains only synthetic prompt/tool content.
Tests invoke this production Adapter, not a separate model of its behavior.
The [foreground fixture record](fixtures/native-foreground-child-2.1.263/README.md)
contains a controlled native Claude Code 2.1.263 direct Agent/Read family produced
with a loopback model mock, not personal history or live provider billing.
The [manual-compaction fixture record](fixtures/native-manual-compact-2.1.263/README.md)
retains separate before/compacted/continued snapshots from the same controlled
native version, with the original prefix preserved and no UUID replay. It
establishes the selected source shape. Local checks passed all 96 Adapter tests,
typecheck, installed `verify:package`, Collector/Go E2E and the installed-daemon
contract over authenticated HTTP with real PostgreSQL. The latter covers
Reader/Search navigation, exact usage, Raw byte continuity and policy/redaction
recovery, source diagnostics and retained history. A 100-Thread regression also
verifies root/child pagination under the Canonical byte bound. Provider-specific
browser staging and historical published-binary upgrades remain unverified.
The [current Claude guide](../../docs/adapters/claude.md#verification-and-remaining-work)
owns the detailed acceptance evidence and limits. See
[ADR-0087](../../docs/architecture/adr/0087-claude-foreground-subagents.md) and
[ADR-0088](../../docs/architecture/adr/0088-claude-manual-compaction-on-legacy-capture.md) for the
selected scope. This records no package publication or
deployment.

For a local development build, install `./adapters/claude` through Integration maintenance before choosing tools.
