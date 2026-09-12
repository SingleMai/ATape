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
an absolute single file for diagnostics. Symlinks and nested subagent histories
are not traversed. The first UUID record's original CWD establishes attribution;
directory names and later directory changes do not reassign a Session.

Git Projects use shared Host attribution across worktrees and independent clones.
Foreign repositories are excluded; missing original directories without retained
evidence produce an attribution diagnostic. Both CLI and Adapter require
`atape.git-attribution.v1`. Ordinary-directory matching remains path-scoped.

The implemented source is a single-root, linear append-only UTF-8 JSONL history:

- User/assistant text and bounded tool calls/results, including escaped Input/Output
  details in the common reader. Tool summaries feed Search; full tool values do not.
- Stable record UUID and physical block-slot Event identities, with per-Session
  incremental progress and one changed Session per page.
- Complete-line parsing, bounded text fragments and appendable Raw objects.
  Source deletion retains captured history and checkpoints.
- Source failure isolation: healthy Sessions continue; failed Sessions retain
  progress and are retried. Duplicate identities are isolated rather than merged.

Continuation/compaction, branching/rewind, subagent and spill collection are not
supported. Unknown content and nonempty thinking remain Raw when captured;
tool-bearing projections retain partial fidelity. The retained controlled native
fixture comes from Claude Code 2.1.263; it is not a blanket compatibility promise
for every Claude version or history shape.

## Bounds and Raw policy

The [package README](../../adapters/claude/README.md#explicit-limits) owns detailed
source/cursor ceilings: 16 MiB records, 256 KiB text fragments, bounded discovery
and compressed metadata cursors. Large total archives stream across pages;
changed files still require hashing previously captured bytes to verify prefixes.
Smaller Host budgets may reject a record or fragment that cannot fit.

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
