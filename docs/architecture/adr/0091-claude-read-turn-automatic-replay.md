# ADR-0091: Claude Read-turn automatic replay on legacy capture

- Status: Accepted scope; implementation and acceptance are recorded in the feature guide
- Date: 2026-10-08

## Context

[ADR-0092](0092-claude-manual-read-file-reinjection.md) later selects a separate
manual Read2 file-reinjection profile; it does not broaden this automatic replay.
[ADR-0094](0094-claude-repeated-single-read-auto-file.md) later selects existing-slug
single-Read replay with one proved prior-file reinjection; it retains this
decision's exact-two first-slug bounds.

Controlled native Claude Code 2.1.263 sources establish one automatic round in
each of two independent root Sessions. A single Read copies U/G/P/C/R/A; an
exact-two Read copies U/G/P/C0/C1/R0/R1/A. G and A are token-reminder attachments.
U/G are copied but excluded from retained metadata, which selects P through A.
Copies add only the first common slug; all other decoded values are equal.
Each group ends in a new boundary B and internal summary S, followed by a real
two-record text response at API indices 0/1 and later resumed conversation.

The current strict text replay profile safely stops at the first duplicate U.
The single case executes only Read a; mock text mentioning b is not evidence of
a second executed call. Summary API usage is absent from JSONL. Both existing
sources record isolated config/workspace but do not establish fresh HOME.

## Decision

Keep the Claude Adapter Module Interface, legacy batch mode, projection 4 and
existing identities. Provider-specific proof remains private to the Adapter
Implementation; Canonical, Raw and Search keep their existing ownership.

At a duplicate U, select a supported candidate using current seen-tail identity,
then authenticate its entire exact physical original suffix from the same current
committed-prefix bytes and digest. No fallback may hide changed, malformed or
oversized proof. Only fully committed records enter the suffix; Event-only or
usage-pending records and a pending Read-pair stage do not qualify.

For the new tool profiles, prove all six/eight adjacent root records, exact
Session/CWD/version/ownership and native marker omissions. U is an ordinary
external user with a valid prompt. G is its token reminder. P is one nonempty
text@0; its adjacent successful Read calls have matching API ID/model/role,
tool_use stop reason and indices 1 or 1/2. Known fully committed calls must
match source UUID/tool IDs. Successful receipts match literal call paths, own
parent/sourceToolAssistantUUID, tool IDs and U's prompt. A is the final reminder
parented by the last result. The two-result graph uses the existing exact-two
Read rules, rather than treating all parents as a linear chain.

Originals omit slug. Each copy must equal its entire original decoded record
after removing only the added common valid slug. Preserve unknown values; do
not compare only selected fields or regenerate tool output. B must name P/A
as retained endpoints, A as logical parent, and precisely P-through-A in both
preserved UUID arrays. Both anchors select a new S. S retains U's prompt,
parent B, slug and sampled internal-summary flags and shape.

All six/eight copies plus B/S commit as one eight/ten-record Raw-only group.
An incomplete group waits before its first copy; an invalid complete slot fails
without acknowledging it. Fresh source capacity must fit the entire group;
insufficient remaining capacity defers it. Commit physical order by the actual
group count, add only new B/S to seen, and do not project copied Events or usage.
Independent Raw receipts retain their existing source-contiguous recovery.

Reuse the existing private v1 autoText pending-answer state. End the group page;
require the first real single-text index-0 answer parented by S with its slug,
and clear only on its full Event/usage/bytes commit. The native second text
record then uses ordinary chaining and latest API usage. No new cursor field,
Host/Server Seam or alternate uploader is needed.

The new profiles use explicit policy limits: 64 KiB including LF per original,
copy and control record, 512 KiB retained original byte tail and 640 KiB group.
The existing text profile retains its 256 KiB tail/group and 16 decoded-tail
policies. Ordinary Read parsing remains 16 MiB, but larger results are outside
this replay witness profile. Prefix proof costs O(committed prefix) I/O/hash;
the same handle does not supply an atomic filesystem snapshot.

## Alternatives

- Generic duplicate suppression loses changed copies, stale originals, parent
  conflicts and copied usage evidence; it cannot justify hiding source records.
- Canonical reprojection of copies would replay existing Event/usage revisions
  and couple recovery to incidental deduplication instead of proved source scope.
- A new cursor stage per copied record can acknowledge partial groups but needs
  a larger compatibility protocol to retain authenticated originals and recover
  invalid later controls. The bounded atomic group hides this complexity behind
  the existing Interface and preserves Depth, Leverage and Locality.

## Scope and verification

Only the two sampled first-slug layouts are selected. Existing-slug repeated
tool replay, tool-only/no-plan layouts, more/other/error/async/reordered calls,
children, file reinjection, manual tool compaction, fork/rewind/cross-file and
Active Path replacement remain separate work.

Verify native snapshots and every incomplete LF prefix through the public
Adapter, fresh runtimes, one-Event pages, exact retry, large/deep unknown values,
copy/metadata/source/cursor faults, pending answers, source capacity and Raw
off/backfill. Verify actual previous merged opaque cursors and installed tarball
recovery. The managed HTTP/PostgreSQL contract must preserve old Reader prefixes,
tool associations, one latest usage per API, exact message-only Search anchors,
complete physical Raw bytes, idle pending recovery and prior policy/repair cases.
Record actual acceptance in the owning guide. Publication and Server deployment
remain separate actions.
