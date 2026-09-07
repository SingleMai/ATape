# ADR-0027: Transactional Capture Checkpoints and Independent Raw Recovery

- Status: Accepted design; Implementation pending
- Date: 2026-09-07

The new publication/Raw capabilities require atomic identity pins, delivery receipts and source/scanner checkpoints; the legacy JSON cursor and per-operation file lock cannot provide that joint transaction or fence concurrent remote writes. Select a metadata-only SQLite journal behind the Collector state Interface, preserving legacy installation identity and Codex state. Independently add owner-scoped Raw metadata reconciliation and fenced, idempotent delivery units; never derive source offsets from redacted output size.

## Trade-off

A monolithic JSON rewrite amplifies every metadata update; a sharded file journal would require a bespoke transactional recovery protocol. Built-in Node SQLite provides Depth at the persistence Seam without a new external database process, but introduces schema, initialization/loss detection, WAL/backup and cross-platform durability obligations. It does not make remote writes atomic with local state or restore vanished source payloads. A payload spool remains out of scope.

## Consequences

- Atomically reserve stable identity/origin before remote Begin. Persist Canonical activation, Raw delivery and completed source coverage separately; advance coverage only over completed obligations without holes.
- Require both local ownership epochs and independent server fences. Raw reconciliation is authenticated metadata for the caller's own capture scope, not permission to download Raw bodies or provider-specific server grouping.
- Freeze source boundaries and transformation/packing identity; verify bounded replay before retry. Changed or irrecoverable source stops the affected obligation or starts an evidenced new generation, never silently becomes complete.
- The source guarantee is a verified bounded sample, not an atomic filesystem snapshot under arbitrary concurrent rewrite. Preserve unfinished accepted Raw and prior Canonical visibility; deleted intermediate source cannot be reconstructed from a digest.
- Keep legacy capability/write modes isolated and fail closed on new-journal binding/corruption or unsupported capability. First enabling the capability upgrades JSON state to a version that preserves installation/Codex progress and records journal initialization; older Hosts reject that format rather than erase its marker. Do not silently reset an existing installation's ownership ledger.

This amends ADR-0009's checkpoint mechanics only for the new capability and extends ADR-0007's Raw write control. ADR-0025 visibility and ADR-0026 byte framing remain unchanged. The consistency design (retained as local research evidence) selects limits, transaction ordering, initialization/recovery and Interfaces. Local model tests do not satisfy the required real-file crash, packaged-runtime, multi-process server, authorization or supported-OS release gates.
