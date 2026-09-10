# ADR-0072: Capture journal metadata admission

- Status: Accepted implementation detail of ADR-0059
- Date: 2026-09-11

Payload reclamation leaves identity, source versions, observation membership and
receipts behind. A controlled journal-only experiment with 1,000 completed captures
and ten records per capture retained zero payload bytes but a 4,153,344-byte SQLite
database and about 1.1 MiB WAL. These are synthetic measurements, not release
capacity defaults or a claim of remote receipt acceptance.

## Interface and alternatives

Add one required `metadataEntries` count to the existing CaptureJournal budget
Interface. It covers the entire account journal: scopes, captures, units, latest
source record versions and per-capture record membership. Existing per-field,
per-target and payload-byte bounds remain independent. Source Collector requires
this explicit admission alongside its other budgets; no unlimited default is
introduced. Test fixtures declare their own capacities.

Deleting old completed captures was considered and rejected for this increment:
version provenance, current coverage, historical Event Raw references and pending
Raw units can still depend on them. Safe retention needs its own proven lifecycle.
A physical SQLite file limit alone was rejected because it can prevent storing a
receipt needed to settle already admitted work. A per-Session limit was rejected
because arbitrarily many small Sessions bypass it.

A global entry count gives this Module Depth without another Seam. Its
Implementation maintains a transactional ledger, checks only new row admissions,
and preserves the existing Interface for recovery. It bounds logical retained
metadata, not exact filesystem allocation, WAL growth, process RSS or retention
age. Numeric release defaults still require representative capacity testing.

## Transaction and recovery semantics

Journal format 6 adds one ledger value to the existing binding. After verifying
account/installation identity, a single upgrade transaction counts the five tables
and installs insert/delete accounting triggers. The one-time count uses constant
application memory. Existing identity, versions, payloads, receipts and checkpoints
remain unchanged. Old formats 1–5 upgrade through the same verified path.

All admission checks run inside the existing `BEGIN IMMEDIATE` transaction. A
new scope, capture or unit consumes one entry. Recording a source observation
consumes one membership entry plus one version entry only if its identity is new.
Both entries are admitted atomically; a rejected observation cannot advance its
version. Idempotent retries and changes to existing rows do not consume entries.
Concurrent connections cannot each consume the same final slot. Current-version
writers use the same admitted configuration, consistent with existing payload
budgets. Stop older Collector processes before upgrading; mixed-version concurrent
writers are unsupported.

At the limit, or after reopening with a limit below current usage, new metadata
fails with a typed capacity error reporting used/limit/required entries. Existing
owner claims, sealed delivery, receipts, activation, cancellation and bounded
payload reclamation continue to work. Opening an over-limit journal does not
silently discard it or make recovery unavailable. Increasing the explicit budget
permits new admission; this increment provides no automatic pruning or reset.

Reclaiming a body does not release a metadata entry. Abandoned and completed
captures remain charged while their metadata is retained. A future explicit
retention operation can use the same transactional delete accounting after it
proves that references and replay evidence are no longer needed.

## Delivery scope

Tests use the public journal Interface and actual SQLite across close/reopen and
concurrent connections, then exercise Source Collector recovery at exhausted
admission. Binding-before-upgrade, partial admission rollback and monotonic source
versions are regression requirements. The full native HTTP/PostgreSQL Collector
fixture remains part of integration acceptance.

This increment selects no production capacity defaults, enables no OpenCode
package, publishes no artifact and deploys no instance. Physical capacity and
installed-artifact/platform/background acceptance remain separate work.
