# ADR-0062: Source record versions and independent coverage

- Status: Accepted implementation detail of ADR-0059
- Date: 2026-09-10

Mutable source rows need persistent versions and membership independently of a
scanner cursor. A timestamp cannot distinguish A→B→A, and Canonical activation
cannot prove that its Raw observations were archived.

## Decision

Extend the existing `CaptureJournal` Module with explicit record tracking. Its
Interface allocates versions, binds records to frozen units or explicit Raw gaps,
pages record metadata and known local sources, and returns coverage pointers.
The same SQLite transaction boundary owns versions, capture membership, local
owner fencing, seals and activation. No new storage Seam is introduced.

For each source scope and kind (`session`, `thread`, `event`, `usage`, `raw`), a
source key has a monotonically increasing safe-integer revision. A different
fingerprint or projection profile consumes a new revision. Abandonment never
rolls counters back. Within a capture, repeating a key with different content
conflicts; recovery cannot stitch together different source views. Only a complete
locally sealed comparison establishes absence, using immutable membership and a
per-plane pointer. Reappearance after known absence consumes a new revision.
Incomplete or failed pages never establish absence. The allocated version records
which complete comparison it consumed, so retrying an interrupted reappearance
does not consume another revision from the same absence evidence.

The Host supplies SHA-256 fingerprints of the stable validated Canonical projection,
excluding assigned revision, observation timestamps and Raw provenance. It includes
all semantic fields, such as ordering and relationships. Raw fingerprints cover the
actually observed complete row state and masking profile; limited metadata cannot
prove identical full Raw bytes. Projection profiles version that interpretation.
The journal stores only bounded keys, fingerprints, profiles, counters and minimal
Event Raw-reference metadata, never an extra source JSON cache.

An unchanged Event version retains its original Raw reference, including an
unavailable reference from Raw-off preparation. A changed version adopts its newly
proposed provenance. An object reference first allocated by an unactivated capture
is orphaned: a fresh capture allocates a new revision instead of reconstructing
that object from a later read. Raw-off preparation cannot create an object reference
for a new version. An already activated version's provenance remains immutable.

Canonical records bind to their own replacement units. A Raw record may bind to
its own unit, an explicit `limit`/`redaction` gap, or an activated same-source
capture's matching revision/fingerprint/profile and original Raw unit. Reuse
flattens the link to its owning unit. Pending bytes must still exist; acknowledged
units remain reusable after payload cleanup; canceled units cannot be reused.
Record coverage joins the actual unit disposition, so cancellation or a later
real ACK requires no fan-out membership writes.

Sealing verifies exact per-kind counts and a binding for every record. Canonical
requires one Session and its Thread topology; Server validation still checks the
actual wire content and full topology. A complete observed Canonical or Raw plane
switches its comparison pointer at seal. Only verified Canonical activation switches
published Canonical coverage, in the transaction that stores its receipt/checkpoint.
Old receipt replay cannot roll either pointer back. Raw observations never change
Canonical coverage.

Tracked Raw-only observations may have zero new units when they preserve existing
obligations, record explicit gaps, or establish a complete empty source scope.
An empty partial comparison is rejected. This refines ADR-0061's nonempty-unit rule
for tracked callers; untracked callers still require at least one unit. Capture
`completed` describes its own wire obligations, not successful archive coverage:
linked pending Raw and explicit gaps remain visible through `records`.

## Storage and alternatives

Journal format 4 upgrades a verified format 1–3 binding transactionally, preserving
bytes, receipts, purpose and checkpoints. Tracking is explicit and requires an
explicit `recordsPerTarget` admission budget. Existing untracked Canonical coverage
cannot silently bootstrap counters at one; a tracked source cannot subsequently
publish untracked Canonical content. OpenCode has not shipped, so this adds no
implicit production source migration.

Per-capture immutable membership plus constant-size pointers was selected over
updating every absent record at activation. It keeps activation short and makes
comparison scope reviewable. A separate revision database would split atomic
coverage/receipt updates and duplicate ownership recovery. Timestamp-derived or
hash-derived counters cannot preserve monotonic observed versions.

Metadata reads use indexed keyset pages of at most 100 rows and load no payloads.
Append determines contiguous unit counts with two indexed last-ordinal seeks.
Sealing performs one bounded-by-admission membership validation. Metadata retention,
SQLite free pages and WAL are not covered by retained-payload byte budgets; physical
capacity and long-term retention remain release acceptance work.

## Validation and remaining scope

Public Interface tests use real SQLite for A→B→A, abandoned versions, absence and
empty scopes, immutable provenance, pending/ACK/canceled reuse, bounded paging,
owner fencing, migration and incomplete manifests. Publication workflow tests
verify tracked Canonical activation and Raw-only gap recovery without an upload.

This increment does not read OpenCode, project source content, schedule captures,
bootstrap production journals or enable an Adapter. The Host must still establish
coherent source views, prepare and freeze validated/redacted bytes, and select
fresh Raw identities and profiles under the authenticated policy.
