# Claude Code Adapter

The Claude Adapter discovers Project-scoped JSONL history and delivers it through
ATape's paged Collector. The Host owns attribution, redaction, Canonical/Raw
uploads and checkpoints. Claude uses the legacy batch write mode; it does not
use OpenCode's atomic publication or SQLite capture journal.

## Install and enable

Use **Tools and updates** to add Claude to the existing global tool selection,
reviewing its effect on all connected Projects. Package installation alone does
not authorize capture. See the [package README](../../adapters/claude/README.md)
for local build/install commands and the [CLI guide](../cli/setup-and-adapters.md)
for Project setup and tool management.

## Sources and supported history

Discovery reads `~/.claude/projects/*/*.jsonl`. `ATAPE_CLAUDE_HOME` selects an
absolute alternate configuration directory; `ATAPE_CLAUDE_SESSION_FILE` selects
an absolute single root file for diagnostics. Symlinks are not traversed. Child
files are read only through the foreground relationship described below; other
subagent directories are not recursively scanned. The first UUID record's
original CWD establishes attribution;
directory names and later directory changes do not reassign a Session.

Git Projects use shared Host attribution across worktrees and independent clones.
Foreign repositories are excluded; missing original directories without retained
evidence produce an attribution diagnostic. Both CLI and Adapter require
`atape.git-attribution.v1`. Ordinary-directory matching remains path-scoped.

Root and admitted foreground child streams use append-only UTF-8 JSONL. Ordinary
records form a strict linear chain; the root also admits the narrow native manual
compaction profile below:

- User/assistant text and bounded tool calls/results, including escaped Input/Output
  details in the common reader. Tool summaries feed Search; full tool values do not.
- Stable record UUID and physical block-slot Event identities, with per-Session
  incremental progress and one changed Session per page.
- Complete-line parsing, bounded text fragments and appendable Raw objects.
  Source deletion retains captured history and checkpoints.
- Source failure isolation: healthy Sessions continue; failed Sessions retain
  progress and are retried. Duplicate identities are isolated rather than merged.

Conversation records require a valid UUID and matching Thread identity before
projecting either Events or usage. UUID-less native bookkeeping remains Raw-only;
it cannot create a turn or an assistant usage record.

Auto-compaction, cross-file continuation, child compaction, branching/rewind,
background or nested subagents and spill collection remain outside the supported
profiles. Unknown content and nonempty thinking remain Raw when captured;
tool-bearing projections retain partial fidelity. The retained controlled native
fixture comes from Claude Code 2.1.263; it is not a blanket compatibility promise
for every Claude version or history shape.

## Foreground subagents

[ADR-0087](../architecture/adr/0087-claude-foreground-subagents.md) selects ordinary
completed foreground children without changing legacy write mode. A root `Agent`
or `Task` result must declare `toolUseResult.status: "completed"` and `agentId`,
be non-asynchronous and non-error, and match the tool invocation through its
tool-use ID and exact `sourceToolAssistantUUID`. The selected source is
`<root-file-directory>/<sessionId>/subagents/agent-<agentId>.jsonl`. Its first UUID
record must share the root's Session ID and original CWD, declare the selected
Agent ID and `isSidechain: true`. Merely finding a file in that directory does
not authorize collection. The `.meta.json` sidecar is not read for capture.

The root's original Project attribution applies to the proved child. Each child
becomes a `claude-agent:<agentId>` Thread under `root`, linked from the actual
parent tool result in the reader. Child CWD changes do not reassign the Session.
Root Event and Raw identities are preserved. Each child has independent prefix,
Canonical and Raw progress, so its pages can resume without replaying acknowledged
root content. Existing version-1 single-file and version-2 discovery cursors remain
supported; version 2 gains optional `children` checkpoints, child traversal and
family revision/time metadata without discarding old progress. Projection
revision 4 reprojects older supported root checkpoints once to find their
foreground receipts, retaining Event IDs and verifying committed prefixes.

This additive profile does not supply atomic family replacement or change a
published child's parent. Unproved, malformed or unsupported child histories
produce local diagnostics without blocking other attributable sources. Missing
children retain acknowledged progress without a new failure; a child that has
never been captured remains a missing-source diagnostic. Nested/background delegation,
interrupted child runs, child forks, child compaction and rewind require further native
profiles and are not enabled by accepting ordinary foreground evidence.
Root pages are drained before child pages; a sustained root backlog can delay
child capture. Admitted children rotate between pages once the root is caught up.

## Manual root compaction

[ADR-0088](../architecture/adr/0088-claude-manual-compaction-on-legacy-capture.md)
selects one additive `/compact` profile from native Claude Code 2.1.263. It keeps
the original source prefix and pre-compaction conversation, then appends real
continuation turns to the existing root Thread. It does not replace the Active
Path or migrate legacy capture to source publication.

Admission requires a root `compact_boundary` with `trigger: "manual"`, a null
physical parent and `logicalParentUuid` equal to that stream's current last UUID.
Both preserved-segment endpoints and the sole preserved-message UUID must equal
that UUID; the preserved anchors must select the immediately following summary.
That summary must be a user-shaped native record parented by the boundary with
`isCompactSummary` and `isVisibleInTranscriptOnly` both true. The supported chain
then contains the native local-command caveat, `/compact` command, command stdout
and zero-token `<synthetic>` `No response requested.` assistant bridge. Every
UUID edge and control marker must match the admitted profile. Missing records
can wait for later appends; conflicting records produce a source diagnostic.

Inside this proved chain, the boundary, summary, command controls and synthetic
bridge remain Raw-only, subject to the user's Raw policy. The internal summary
is loaded into the next model request; it is kept out of Canonical because it is
provider-generated context rather than a new user message. It does not appear as
a user turn or Search result, and the bridge is not a real assistant response.
Records outside the admitted state machine retain their existing projection; an
unbound compact summary is unsupported.

An optional versioned compaction stage lives in the existing stream checkpoint.
Its expected UUID and phase advance with the prefix hash, byte offset and record
order only after a complete record is accepted. A bounded page can stop at the
boundary, summary or command controls, recreate the runtime and continue without
forgetting the required next record. Supported old cursors remain valid and
projection revision 4 is retained. Existing Session, Thread, Event and Raw keys
remain stable; no old Canonical Event is withdrawn or reassigned.

Token completeness has a source limit: this native compact request has no
assistant response record in JSONL, so its actual model usage cannot be recovered.
`compactMetadata` token counts are context bookkeeping and are not converted to
assistant usage. Only real recorded assistant responses contribute usage; the
synthetic bridge's zero counters do not create a usage item. The profile does not
enable automatic compaction, larger preserved segments, copied UUID replay,
cross-file continuation, child compaction, rewind or forks.

## Bounds and Raw policy

The [package README](../../adapters/claude/README.md#explicit-limits) owns detailed
source/cursor ceilings: 16 MiB records, 256 KiB text fragments, bounded discovery
and compressed metadata cursors. Large total archives stream across pages;
changed files still require hashing previously captured bytes to verify prefixes.
Smaller Host budgets may reject a record or fragment that cannot fit.
Canonical pagination reserves the encoded root/child Thread headers before
adding Events or usage, including a newly admitted child's header. Wide families
therefore retain the requested page bound for both root and child text pages.

The Adapter declares `atape.raw-capture.v1`. With Raw disabled, Canonical continues
without advancing Raw upload receipts. Re-enabling Raw backfills retained source
bytes under the [current capture policy](../cli/raw-capture.md). Unsupported or
oversized tool values remain available only if Raw was actually captured.

## Recovery and upgrades

Inspect Project → Sync details in ATape for partial collection.
Source diagnostics are bounded, redacted and local; they do not assert that all
failed files have been enumerated. Repair malformed data or restore the exact
captured prefix to resume. Unsupported history needs an Adapter capability;
resetting a cursor does not make it supported.

Preserve the full CLI state directory. A package-version change alone does not
reset progress: the Adapter checks cursor schema and captured-prefix integrity.
Unknown formats or changed prefixes fail explicitly. Package replacement tests
prove recovery mechanics using re-versioned current bundles, not compatibility
with every historical binary.

The receiving Server must accept `atape.acp-centered.v2` before a CLI emitting
bounded tool details is used. Existing v1 requests remain accepted without tool
details. Use the coordinated release and [release guide](../releasing.md);
package publication and Server deployment are separate actions.

## Verification and remaining work

Relevant checks are Adapter tests, `pnpm test:e2e`, `pnpm test:adapter-package`
and `pnpm test:release`. They cover production discovery/projection, shared tool
redaction, large-archive pagination, source failure isolation and installed-package
replacement. They use controlled data, not personal history.

Wider Claude history support and
changes to prefix-verification cost require their own compatibility evidence;
no cursor reset, alternate uploader or implicit source migration is promised.

The [foreground fixture record](../../adapters/claude/fixtures/native-foreground-child-2.1.263/README.md)
was captured on 2026-10-08 from the installed Claude Code 2.1.263 using an isolated
configuration and deterministic loopback Anthropic SSE mock. Claude produced the
Agent identity, parent receipts, sidechain records and actual Read result; model
text, IDs and usage were controlled. No personal conversation or live model was
used. This establishes one completed direct foreground Agent with Read, not
nested/background execution, resumed children or other versions. The Adapter
also recognizes the legacy `Task` tool name; this corpus samples `Agent`.

The [manual-compaction fixture record](../../adapters/claude/fixtures/native-manual-compact-2.1.263/README.md)
records a separate native Claude Code 2.1.263 run on 2026-10-08 with isolated
configuration and the deterministic loopback model mock. Its before, compacted
and continued snapshots retain the same byte prefix, with one preserved tail
UUID, no replayed UUIDs and a real continuation request that loads the summary.
The corpus contains three real assistant usage records and one zero-token native
synthetic bridge; the compaction response itself is absent from JSONL.

On 2026-10-08, local `pnpm check` passed before the final family-header budget
and conversation-identity corrections. After those corrections, Claude typecheck, all 96 Adapter behavior
tests and installed Claude `verify:package` passed. The regression exercised
100 Threads with near-3 MiB root and child text, bounded Canonical pages, stable
retry, 619 unique Events and 100 complete independent Raw objects. The four
Collector/Server E2E tests and CLI typecheck passed; architecture and documentation
guards also passed. Adapter checks cover old checkpoints, Raw off/on, unfinished
compaction stages, malformed controls, unsafe family paths and conflicting
ownership without resetting acknowledged progress.
Malformed conversation UUIDs and mismatched root/child identity are rejected
before Events or usage, while native UUID-less bookkeeping stays Raw-only.

The installed package and shared Collector/Go HTTP path captured the foreground
family as eight Events, four assistant usage records totaling 68 input and 36
output tokens, and two Raw streams. Manual before/compacted/continued capture
retained six Events and three real usage records totaling 81 input and 37 output
tokens; the compacted stage added zero Events and usage. Bounded package pages
recreated the runtime, retained old Event and Raw identities, retried without
duplicates and captured every retained source byte, including controls.

`pnpm test:claude-contract` additionally passed the required named contract on
real Docker/PostgreSQL and authenticated HTTP using installed CLI/Claude
tarballs and an actual managed daemon restarted at each source stage. It verified
Project attribution, root-to-child Reader navigation, exact Search Thread/anchor,
the same usage totals, stable Raw object/generation, paged Raw byte continuity,
unchanged polling, shared Canonical/Raw redaction, Raw off/on backfill, unsupported
append isolation, exact-source repair and history retention after source deletion.
Summary, command and synthetic bridge text stayed outside Canonical/Search.
Legacy Reader Sessions still use complete reads; this contract does not establish
publication-head pagination. The combined PostgreSQL CI guard now requires the
Claude subtest itself to pass, rejecting missing or skipped results.

Controlled counters establish projection and deduplication, not provider billing.
CLI `test:cli-package` passed for the foreground increment; the manual increment's
local evidence uses installed tarballs rather than a rerun of that terminal suite.
Provider-specific browser staging and upgrades from historical published binaries
remain unverified. Existing legacy concurrent-writer, lost-checkpoint and pending
delivery after source-loss limits remain. No package publication or Server
deployment is claimed.

Full Active Path support additionally needs an explicit legacy-to-publication
migration; switching the Adapter manifest or deleting checkpoints is not one.
The next additive increment is a same-response split assistant tail retained by
manual compaction. Automatic compaction needs a separate proved UUID-replay
profile, and parallel tool-result parents need a tool-batch profile; neither is
enabled by the current manual boundary rules.
