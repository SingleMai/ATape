# ADR-0111: Cursor native source reader before capture enablement

- Status: Accepted for the source-reader increment
- Date: 2026-10-10

Later amendment: [ADR-0113](0113-explicit-unknown-conversation-time.md) defines
shared unknown-time semantics. It does not enable Cursor capture or establish
native creation attribution.

## Context

Cursor transcript discovery, content decoding and capture admission are different
questions. Confab's pinned Cursor tests provide message JSONL, turn status and
sidecar examples, but they do not provide per-event timestamps, native message
IDs or original project evidence. The workspace slug is lossy. A fixed Cursor
CLI bundle also shows that missing sidecar metadata may be created from the
current workspace and current clock. Sticky sidecar CWD alone therefore does not
prove a historical Session's original Origin.

The user authorized constructed Confab-derived fixtures on 2026-10-10 and deferred
live Cursor acceptance. This establishes the evidence scope for this increment;
it does not establish a supported CLI or IDE version.

## Interface alternatives

1. A generic file/line callback Interface would expose path validation, bounds,
   decoding, status handling and metadata interpretation to each caller. It has
   little Depth and spreads provider knowledge outside the Adapter.
2. A complete sourceCapture factory would provide more Leverage, but its current
   Interface requires original GitSource attribution and occurrence timestamps.
   Guessing these from a slug, mtime or first observation would violate existing
   contracts. Shared unknown-time semantics and creation evidence need their own
   implementation and acceptance before this shape can be enabled.
3. A bounded native-source Module provides discovery and a validated snapshot
   without claiming Canonical admissibility. This keeps compatibility work local
   and makes the missing source facts explicit.

Select the third shape for this increment.

## Decision and ownership

The private `adapters/cursor` package owns one native-source Module. Its Interface
has two independent Effect operations: `discoverCursorSources` and
`readCursorSource`. Callers supply an absolute state directory and explicit
limits. Discovery returns root candidates, an opaque continuation cursor and a
completion flag. Reading returns complete validated records, source-location
facts, optional metadata candidates, child-file candidates and filesystem
observation metadata. It always reports original project attribution as unknown.

The Implementation hides native directory traversal, path checks, duplicate
identity checks, bounded byte reads, UTF-8/JSON validation, metadata lookup and
resource lifetime. Missing event times, native event IDs and tool call IDs remain
unknown. It preserves raw rows and text instead of manufacturing tool results,
thinking, model or usage. Filesystem mtime is labeled as an observation and is
excluded from the content digest.

The supported snapshot requires complete newline-terminated records and stable
file reads. Unknown record/content shapes, incomplete tails and changed files
fail through the typed Interface. This increment has no selected Canonical head,
so it makes no append, truncation, compaction or deletion-recovery promise.
Child paths establish location candidates, not a proven parent-child graph.

The filesystem is a local-substitutable dependency; tests use real temporary
files through the same Interface. There is no public filesystem Seam added for
mocking. The existing installed Adapter Host remains the future package Seam.
No factory, Adapter manifest, tool catalog entry or new executable is introduced
until that Adapter can meet its capture contract.

This provides Depth by hiding source acquisition and validation, Leverage for
the future projection Implementation, and Locality for Cursor compatibility
changes. Deleting the Module would move this provider-specific complexity into
future Host or projection callers.

## Consequences and verification

The package remains private and unselectable in the CLI. Constructed fixtures and
their pinned provenance verify only the selected source-reader profile. Live
Cursor CLI and IDE samples remain separate acceptance work.

The next capture increment must represent missing event and Session times
faithfully across the shared protocol, Server and reader, and establish a
production-usable creation proof. Neither metadata repair nor a generic
`sessionStart` observation may silently adopt unknown historical attribution.
Use the existing Host for Git matching, redaction, revisions, Raw preparation,
publication and recovery once the source is admissible.

Current behavior, checks and limits belong to the [Cursor guide](../../adapters/cursor.md).
