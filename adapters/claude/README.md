# Claude Code Adapter — first implementation slice

Discover Project-scoped Claude Code JSONL Sessions through ATape's normal
Collector, shared ACP profile, server and existing conversation page.

```sh
pnpm --filter @atape/adapter-claude build
pnpm atape adapters install ./adapters/claude
pnpm atape adapters enable claude --project YOUR_PROJECT
pnpm atape collect --once --project YOUR_PROJECT --json
```

For an offline packaged installation, `pnpm pack:release` now produces the CLI,
Codex and Claude tarballs plus `SHA256SUMS` under `release/`. Install the CLI
tarball, then use `atape adapters install ./release/atape-adapter-claude-0.3.1.tgz`.
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
  attribution. Discovery inspects up to 256 KiB per file for the first UUID record
  and checks its original CWD before reading the complete snapshot. Symlinked
  files/directories and nested subagent histories are not traversed.
- One changed Session per page, with round-robin scanning and per-Session progress
  in the existing Collector checkpoint. Reopening the Adapter preserves progress;
  unchanged Sessions are not re-uploaded. New files and appends are discovered on
  subsequent collections. Moving a file does not create a new Session; missing
  files retain their checkpoints and captured history. Existing single-file v1
  checkpoints are carried forward without resetting their committed prefixes.
- A single root, linear append-only local history with valid UTF-8 JSONL.
- User/assistant text, tool call/status summaries and bounded tool input/output.
  The shared reader displays Input/Output in collapsed, escaped text/JSON details.
  Correlation IDs link call and result within their Session/Thread. Host redaction
  runs before Canonical encoding; null, false, zero and empty values stay distinct
  from absence. Values beyond 64 KiB / depth 32 / 10,000 nodes remain only in Raw.
  Unknown contents and nonempty thinking also remain Raw. Tool-bearing projections
  retain their conservative partial status; this is not complete ACP content support.
- Stable record UUID + physical block-slot Event identities; replay does not
  duplicate messages. Same-model-message split records remain distinct.
- Complete-line eligibility, bounded whole-session observation and existing
  Host secret redaction before Canonical/Raw network requests.
- Immutable Raw snapshot per content digest. Snapshot finalization never marks
  the Claude Session ended; appends produce another snapshot and update the same
  Session/Event identities. Old Raw objects remain available.

## Explicit limits

No continuation/compaction, branching/rewind,
subagent or spill collection yet. Ambiguous graphs, changed committed prefixes,
corrupt checkpoints and snapshots exceeding 4 MiB / 10,000 records / the Host's
500 Events or 3 MiB Canonical limit fail rather than truncate. A smaller Host
limit is honored. One full Raw snapshot is kept per accepted source revision;
this is opt-in bounded-session collection, not an efficient large-session watcher.
Discovery scans at most 10,000 directory entries and keeps a checkpoint of at most
16,000 bytes (capacity depends on path lengths and Session count). Capacity errors
stop collection without evicting old progress. Only sources with readable identity
and original CWD in their bounded header are automatically attributable; use the
single-file override to diagnose malformed or unrecognized headers. An unsupported
attributed source is isolated without marking it captured; other sources continue.
Multiple files claiming the same Session identity are all isolated rather than merged.

## Partial collection

Automatic discovery reports source read/format errors, unsupported histories,
changed prefixes, oversized snapshots and duplicate identities as local
`sourceFailures`. Unattributable headers are diagnosed locally; unrelated bodies
are not uploaded. Healthy Sessions still advance; failed Sessions retain their
committed progress and are retried next cycle. Repair a malformed source or restore
its exact captured prefix to resume it. Unsupported history needs a future Adapter
capability, not a cursor reset. No automatic deletion or permanent quarantine occurs.

`atape collect --once --json` includes the diagnostics and exits nonzero for partial
collection. Text output lists escaped source paths and generic reasons; the Host
masks configured secrets. Background `atape status` shows `partial` and continues
collecting. Reports retain up to 32 distinct diagnostics with a truncation flag,
not an exact count of all failed files. A clean cycle clears previous diagnostics.
Global discovery/cursor capacity, corrupt checkpoints and Host/transport failures
still fail the job. The single-file override stays fail-fast except that unknown
Git attribution is reported as partial coverage. Update the Host and
Adapter together to retain the new optional diagnostic fields.

The current v1 Host's source-mutation/concurrent-writer and lost-checkpoint
recovery limitations still apply. Use a single Collector and preserve its state.
No new SQLite journal or provider-specific page is installed. Bounded shared tool
details ship under ADR-0030; full ACP content, generation tokens and atomic
publication remain deferred.

## Upgrade order

Deploy the updated server (including migration 000010) before the updated CLI and
Adapter. The CLI now emits `atape.acp-centered.v2`; the server still accepts v1
without tool details. Preserve Collector state. Claude reprojects old checkpoints
once with projection revision 2, retaining Event IDs and source revisions; it
does not reset captured source prefixes or invent new Sessions. Finish pending
old-client collection retries before upgrading other Adapters; this slice does
not add a general cross-profile recovery protocol. No package is published by
the development build commands above.

A package-version change alone no longer blocks recovery: the installed Adapter
decodes the persisted cursor schema and revalidates captured bytes. Unknown cursor
formats and changed prefixes still stop/diagnose the affected capture, never reset
it. Preserve the complete CLI state directory, stop the Collector before replacement,
and restart after checking `collect --once`. This is not a promise of old Claude
source-format compatibility; a future breaking cursor format must provide its own
explicit migration or rejection. See [ADR-0032](../../docs/architecture/adr/0032-claude-release-and-recovery.md).

`fixtures/native-read-2.1.263.jsonl` retains decoded records from a real, controlled
Claude Code 2.1.263 invocation, with home/temporary paths substituted. It is not
byte-identical original Raw and contains only synthetic prompt/tool content.
Tests invoke this production Adapter, not a separate model of its behavior.
