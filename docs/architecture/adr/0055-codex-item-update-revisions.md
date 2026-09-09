# ADR-0055: Codex item updates across collection pages

Status: Accepted

## Decision

A Codex completed item ID identifies an evolving item, not an immutable record.
The projection selects its last occurrence within the fixed Session snapshot.
Repeated response-item history uses the first owned source offset so copied
context cannot acquire another Raw reference on a later page. Legacy message
updates with explicit IDs also select their last occurrence.

Canonical Events use the acknowledged snapshot revision. A subsequent changed
snapshot advances beyond its previously completed revision even when the mtime
is unchanged, so an appended cumulative update replaces its earlier projection
without creating a duplicate. In-flight snapshots retain one revision and stable
ownership across pages/restarts. Original source records remain complete in Raw.

Projection v3 replays Canonical history once, including old in-flight pages and
completed per-Session offsets. Raw acknowledgements remain unchanged. This is
required to repair earlier pages where page-local deduplication retained only the
first partial update. Stable Event IDs update existing server records.

## Evidence and verification

A 66 MiB native rollout wrote item-297 twice, eleven milliseconds apart: first a
one-element summary, then a two-element cumulative summary. The two records
straddled a 500-event page boundary. Both had revision 1, causing a 409 on page two.
The same-page path silently retained the shorter first update.

Public Adapter tests cover cross-page cumulative updates with a fresh runtime on
each page, later append revisions, existing copied-history ownership, and durable
Canonical replay without resetting Raw progress. The CLI/Go contract verifies
that source-revision updates retain Event identities and update search projection.
