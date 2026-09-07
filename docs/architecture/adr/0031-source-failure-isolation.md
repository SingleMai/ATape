# ADR-0031: Source failure isolation and local diagnostics

Status: Accepted and implemented

## Decision

The Claude Adapter isolates expected per-source read, format, unsupported-history,
changed-prefix and snapshot-limit failures during automatic discovery. Duplicate
Session identities isolate every claiming file; filename order cannot select a
winner. No failed source bytes are acknowledged. A later healthy source may
publish and advance only its own checkpoint. Failures are retried on subsequent
scans, without a durable quarantine or journal. Existing single-file selection
remains fail-fast for diagnosis.

The existing Adapter page Interface gains optional `sourceFailures` (source path
and a closed generic reason) and `sourceFailuresTruncated`. Each page and job
report retain at most 32 diagnostics, with source paths bounded to 4096 bytes on
input. The Host validates and redacts these local diagnostics, deduplicates across
pages and marks truncation instead of claiming a complete failure count. Empty
diagnostic-only pages leave the source cursor unchanged and terminate pagination.
Diagnostics never enter Canonical, Raw, Search or server APIs.

The Collector still owns transport, checkpoint commits and cancellation. Its
report and managed status expose partial collection; `collect --once` prints the
report before returning nonzero for partial collection. The daemon continues and
shows `partial`, clearing diagnostics on the next clean cycle. Configuration,
corrupt cursors, overall scan/cursor capacity, Host contracts and unknown defects
remain job failures. Failed headers that cannot be attributed are reported only
locally; their bodies are not uploaded to any Project.

## Alternatives and boundaries

1. Keep failing the whole job: small Interface, but one unsupported Session blocks
   every healthy Session and requires users to select individual files.
2. Silently skip or log inside the Adapter: keeps the page unchanged but hides
   partial collection from callers and puts redaction/status policy at the wrong
   Seam.
3. Bounded page diagnostics (selected): preserves Adapter Locality for source
   semantics and gives callers Leverage through one shared Interface. The Host
   hides validation, redaction and aggregation; no new Module or replaceable Seam
   is needed. No provider-specific server knowledge or fake conversation is added.

This is not support for compaction, branching, large histories or release-package
upgrades. Install the updated Host with this Adapter so optional diagnostics are
not dropped by an older Host. Test coverage uses the public Adapter/Collector
Interfaces and real filesystem, CLI and Go server Adapters.
