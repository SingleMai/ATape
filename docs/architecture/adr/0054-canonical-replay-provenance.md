# ADR-0054: Canonical replay across Adapter upgrades

Status: Accepted

## Decision

Canonical ingestion compares normalized Event content independently of Adapter
package and wire-profile provenance. An unchanged Event at the same source and
projection revision is an idempotent replay even when its uploader version changes.
The stored original provenance and ingestion sequence remain intact. Identity,
ordering, fidelity, Raw reference, text, structured tool details and child Thread
links still participate in conflict detection. Real content changes require a
higher source or projection revision.

The Canonical Module owns this comparison. Both memory and PostgreSQL Adapters
use it after a digest mismatch, preserving compatibility with historical digests
without rewriting stored history or changing the ingestion Interface. Batch-key
reuse with different request content remains a conflict.

Codex advances its projection revision for the current projection (including
bounded ACP tool serialization and source-reference changes). Package version
changes alone do not imply another projection revision.

## Evidence and verification

A live backfill failed with 409 when an identical derived spawn Event captured by
Adapter 0.2.0 / profile v1 was replayed by 0.4.6 / profile v2. Source identity,
revision, ordering, text and Raw reference were identical. The digest also included
package and profile versions, blocking later Events in that batch.

The shared persistence contract replays a legacy batch after a package/profile
upgrade, verifies no insert/update or provenance overwrite, and verifies changed
text, ordering and fidelity still conflict. Run it against real PostgreSQL as well
as the memory Adapter. No history reset or conflict bypass is introduced.
