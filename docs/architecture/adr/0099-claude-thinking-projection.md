# ADR-0099: Claude thinking projection and checkpoint upgrade

- Status: Accepted decision; implementation and verification belong to the Claude guide
- Date: 2026-10-09

Later amendment: [ADR-0101](0101-claude-active-path-and-legacy-adoption.md) carries
the same recorded-thinking projection into Claude's sourceCapture v2 writer.
Legacy checkpoint validation remains explicit; current delivery versions are
allocated by the Host above the adopted Server baseline.

## Context

The shared ACP Interface, Canonical projection, redaction and Reader already
support thought Events. The Claude Adapter skips nonempty persisted `thinking`
blocks, so enabling Raw preserves their source bytes without making their
recorded body available in the Reader. Adding those Events changes the visible
projection of source prefixes already acknowledged by existing checkpoints.

## Decision

Keep provider knowledge inside the Claude Adapter Module. Project assistant
blocks whose `type` is `thinking` and whose `thinking` has meaningful text to
`agent_thought_chunk` through the existing collect Interface. Preserve the exact
contents of meaningful fragments, including their surrounding whitespace.
Empty or whitespace-only thinking produces no Event. A
signature, `redacted_thinking` opaque payload, unknown block or non-assistant
thinking block is not a thought body and remains Raw-only when Raw is enabled.
This does not recover reasoning absent from the source.

Use the existing text fragmentation Implementation: at most 256 KiB per UTF-8
fragment, with stable physical UUID/block/fragment Event coordinates and a
UUID/block `messageId` shared by fragments. Existing text and tool Event IDs,
byte revisions, order, tool anchors and Raw references do not move when a
previously skipped physical block becomes a thought. Assistant API usage keeps
its existing latest-original-record identity and is not incremented for thought
Events or replay copies.

Both the shared Host and Server require a nonblank text Event. A whitespace-only
fragment therefore remains Raw-only, using the union of their whitespace rules.
Keep original fragment indices when skipping it; never renumber later fragments.
If a large thought loses a blank fragment, its remaining thought Events carry
partial fidelity. Canonical does not reproduce that omitted whitespace; enabled
Raw preserves the exact body. This avoids blocking meaningful text, tools and
usage without widening the shared Interface or inventing placeholder text.

Advance the Adapter projection revision from 4 to 5 without changing the source
normalization version or checkpoint schema. A supported older checkpoint first
authenticates its committed source prefix and restores its source facts. If an
old checkpoint is inside an Event page, validate its pending next complete
physical record against the old visible projection before resetting projection
progress. EOF, partial LF, control-only records, impossible skip counts and
source corruption must not become valid by upgrading. The old visible skip
index is never applied to the new thought-inclusive Event list.

After validation, reproject the selected source from its beginning once. Raw
receipts remain independent and do not reset. Existing projection-4 Events use
the same source identities at the higher projection revision; the Server replaces their
active snapshots through its existing ingestion Interface. New thought Events
fill previously unused physical coordinates. Usage retains the same source
identity and byte revision. Advance the Session snapshot revision to the spare
even value after projection 4's odd byte-based revision. A thought-only EOF can
advance `updatedAt` without adding source bytes; reusing the old Session revision
would conflict with its acknowledged metadata. Later appended bytes remain
monotonic, and the existing family revision handles admitted children. Event and
usage byte revisions remain unchanged. Root and each admitted child upgrade their own
opaque checkpoints; pending reporting must include an older child at EOF even
when Raw is caught up, while retaining missing captured-source semantics.
Pinned family ownership and unsupported-delegation diagnostics keep their
existing validation rules. Older supported projection 2 and 3 checkpoints keep
their existing accepted compatibility fallback; this does not claim historical
snapshot Event revisions or Raw identities matched incremental capture.

No new Module, Interface, Seam, provider-specific Web rules or Server migration
is required. The shared Reader groups thoughts in Activity and opens the group
for a directly targeted Event. Canonical redaction happens before HTTP ingestion.
Search remains a message-only read model and excludes thoughts. Raw retains its
separate capture policy and source bytes.

## Alternatives and verification

Leaving old prefixes untouched would make thinking completeness depend on when
capture began. Joining Raw into Reader reads would cross the Canonical/Raw
boundary and bypass normal projection and redaction. Reusing the old Event skip
against the new list could lose thoughts or duplicate the wrong fragments. The
selected private upgrade adds Depth and Leverage while keeping provider details
and compatibility behavior local to the Adapter.

Verify through the public factory/collect Interface: mixed blocks, same-API
split records, UTF-8 fragmentation, retries, partial LF, Raw off/backfill,
compaction replay and admitted children. Use an isolated installed Claude CLI
with a deterministic loopback API for native persistence evidence; distinguish
its supplied content and usage from real provider reasoning or billing. Genuine
previous-main opaque checkpoints and a frozen previous installed artifact
establish upgrades separately from generated malformed-state tests. Installed
Collector, authenticated HTTP/Postgres Reader, redaction, Search and Raw checks
establish delivery. The [Claude guide](../../adapters/claude.md) owns the shipped
scope, checks actually run and remaining limits.
