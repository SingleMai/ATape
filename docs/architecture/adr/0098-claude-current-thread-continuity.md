# ADR-0098: Claude current Thread continuity around unlinked delegation

- Status: Accepted decision; implementation and verification belong to the Claude guide
- Date: 2026-10-09

## Context

The foreground family in [ADR-0087](0087-claude-foreground-subagents.md) admits
only direct, completed foreground children with explicit ownership evidence.
Its Implementation currently treats unsupported relationship metadata as a
failure of the entire current source record. A background or unsuccessful root
receipt, or an Agent invocation inside an admitted child, can therefore prevent
that Thread's valid messages, tools, usage and subsequent replies from being
acknowledged. Relationship completeness and current Thread integrity are
different facts.

## Decision

Keep both decisions private to the Claude Adapter Module behind its existing
collect Interface. First validate the selected Thread's source identity,
committed prefix and ordinary graph edges with the same normalizer. Then decide
whether a tool receipt proves an admitted child relationship. No new Seam,
projection revision, checkpoint schema or Server migration is needed. Canonical,
Raw and Search retain their separate ownership.

An ordinary Agent/Task invocation or result remains an ordinary tool Event in
its already proved current Thread. Unsupported delegation metadata does not
block those Events, their real assistant usage, eligible Raw bytes or later
ordinary records. An unlinked receipt yields a bounded `unsupported` source
diagnostic, without creating a Thread header or `childSourceThreadId`, opening
the proposed child file or guessing ownership from its filename. Pending tool
invocations alone are not evidence of an unsupported receipt.

Only the existing unique, completed, non-asynchronous, non-error direct-root
receipt with exact invocation evidence admits a child. A safe locator and a
single tool-result Event are also required for that relationship. Nested,
background, unsuccessful and otherwise unproved child histories remain outside
capture. This increment preserves their current Thread's records; it does not
claim those children are captured.

Conflicting evidence for an already pinned child identity or parent call remains
a hard source failure. Missing relationship evidence is not permission to
ignore contradictory source correlation, stale ordinary parents, mixed Thread
ownership, changed prefixes or malformed records. Raw-only replay copies never
create new relationships or diagnostics. Relationships still commit only when
their complete physical receipt commits.

Rebuild unlinked-receipt diagnostics from authenticated committed source context
on every family collection, including root-only pages, pages from another child
and idle collection after restart. Inspect only the acknowledged prefixes of
already admitted children when a page returns before their normal turn; do not
collect pending suffixes or proposed children for this purpose. Deduplicate them
per source and reason within the bounded existing report rather than storing a
second durable receipt catalog. This keeps diagnostics visible after the current
Thread advances and preserves the existing O(committed source) cold scan cost.
Existing opaque checkpoints resume without rewriting their private state or
replaying committed Events.

## Alternatives and verification

Immediately capturing arbitrary child topologies needs native lifecycle and
ownership evidence beyond this increment. Keeping the current hard rejection
conflates unsupported child capture with invalid parent records. Persisting a
separate unlinked-relationship ledger enlarges the checkpoint upgrade protocol
for facts already available in authenticated source bytes. The selected design
adds Depth and Leverage while retaining Locality inside the provider Adapter.
Family-wide visibility costs scans of unvisited admitted children's committed
prefixes as well as the current stream; it is bounded by actual family source
size rather than a durable diagnostic ledger.

Verify through the public factory/collect Interface with generated mutations of
the retained native foreground fixture, explicitly distinguished from new native
acquisition. Check asynchronous, noncompleted, error, ambiguous, unsafe and
nested receipts; ordinary following messages and usage; one-Event pages, retry,
partial LF, restart, Raw off/backfill and diagnostics on idle. Preserve all
existing source and pinned-relationship conflict checks. Genuine previous-main
opaque inputs, installed artifacts and authenticated Collector/Reader/Search/Raw
delivery establish upgrade and integration behavior. The
[Claude guide](../../adapters/claude.md) owns checks actually run and limits.
