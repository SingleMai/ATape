# ADR-0050: Bounded compressed Codex cursors

Status: Accepted

## Decision

The Codex Archive Module keeps the existing 16,000-byte opaque cursor Interface.
Its Implementation emits ordinary base64url JSON while it fits; larger snapshots
use a `z1:` prefix followed by raw DEFLATE bytes encoded as base64url. Decoding
accepts existing cursor versions and validates the same cursor Schema. Inflation
and serialization are capped at 256 KiB, and encoded input/output remain capped
at 16,000 bytes. Invalid compressed input fails as a typed cursor error.

A supported Session can contain 100 rollout files. Repeating file names,
identifiers, generation values, and JSON field names in an uncompressed snapshot
can exceed the cursor limit before collection starts. Compression preserves every
file and its offsets, so no history or checkpoint needs to be reset or skipped.

## Alternatives and consequences

Increasing the shared cursor limit would enlarge all persisted and transported
checkpoints. Storing snapshots in a separate local file would add a persistence
Seam and a second resource lifetime for callers. Compacting or dropping snapshot
fields risks losing stable file identity during archive moves. A bounded encoding
change keeps this behavior local to the existing Adapter and adds no Seam.

New Adapters resume old checkpoints. Older Adapters cannot read a compressed
checkpoint; rollback must retain the updated Adapter or restore a paired older
checkpoint. Small cursors retain their existing encoding. The compressed form
has a distinct prefix so future encoding changes can be versioned independently
of collection semantics.

Tests use the public Adapter Interface to reopen and resume a 100-file Session,
capture every event and Raw file, and reject corrupt, oversized, or excessively
expanding input. The encoded size limit still applies if compression cannot fit
an unusually large snapshot.

ADR-0053 subsequently raises the shared encoded bound to 1 MiB and decoded bound
to 16 MiB to retain per-Session progress; 16,000 bytes remains the compression
threshold. The historical bounds above describe the initial increment.
