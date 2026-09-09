# ADR-0051: Attribute Codex paginated source files independently

Status: Accepted

## Decision

For metadata declaring `history_mode: paginated`, the Codex Adapter supplies its
stable rollout-file identity to the Host's Git attribution Interface. The identity
is the existing basename-derived Raw object ID, unchanged by moves between live
and archived directories. Ordinary rollout sources keep their Thread-based
identity and existing saved bindings. Session and Thread identities are unchanged.

Paginated files reuse an original Thread ID while recording a new source timestamp.
Using that Thread ID as the source ID collides with the original file's immutable
origin key. The Host correctly rejects conflicting evidence, but this prevented
legitimate later pages of the same conversation from being captured.

## Alternatives and consequences

Ignoring origin-key changes in the shared attribution Module would weaken its
immutable evidence rule for both Adapters. Replacing saved bindings would make
behavior depend on discovery order. Identifying the actual paginated source file
keeps provider-specific behavior inside the Adapter Implementation and preserves
the Host's authorization and evidence rules without a new Seam.

Each paginated source is matched against the configured Project using recorded
Git metadata or its original directory. Existing conflicting Thread bindings are
not modified. If a paginated source has neither recorded repository metadata nor
a resolvable original directory, it remains unknown; no saved remote is guessed.
Newly attributable files behind the watermark use the existing Canonical-before-Raw
recovery path, without resetting the Collector checkpoint. Recovery checks each
file identity and generation, including new files in an already captured Session;
existing Raw progress for another file must not suppress Canonical recovery. An
optional cursor fingerprint records which file identities and generations were
projected, so another file in the same Session triggers recovery even if that
Session was the last one projected. Old cursors remain readable and may replay
Canonical data once before Raw; server ingestion remains idempotent.

Regression coverage uses the public Adapter Interface with a Host callback that
preserves immutable source bindings: original and paginated files sharing a Thread
both publish their events and Raw segments, and archival preserves source identity.
