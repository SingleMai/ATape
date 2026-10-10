# ADR-0109: Runtime identity and serialized capture writes

Status: Accepted (2026-10-10)

Extends [ADR-0107](0107-independent-update-control.md). This increment makes
runtime admission enforceable at local capture/configuration writes. It does not
enable a new capture contract or establish publication.

## Problem and alternatives

The historical capture-v2 bootstrap and the executing runtime currently share a
contract constant. Changing it would change the decoder for historical bridge
metadata. Also, an already-open old console can save configuration after the
control Module raises its minimum runtime version. Checking admission only when
a process starts cannot prevent an in-flight write from committing after a floor
change.

Two materially different Interfaces were considered:

1. A process-long admission lease around the entire console or Collector. It
   excludes old writers, but also makes update progress depend on console exit,
   network calls and nested manual update ownership. It defeats bounded handoff.
2. Runtime identity checked at normal entry and a short per-home write barrier
   inside the existing update-control Module. Actual local commits and floor
   advancement share the barrier. This is selected.

## Interface and invariants

Historical legacy bridge pointers and manual migration receipts retain their
immutable v2 contract. The actual runtime identity is compiled from the CLI
package version and declared capture contract; an old process cannot adopt a
replacement manifest's identity. Bootstrap delegation and owned recovery happen
before ordinary capture admission. Help and version remain read-only.

Release discovery and candidate capability checks use that executing identity.
Existing prepared/pending plans keep their historical v2 format and explicitly
refuse use by another compiled capture contract. Changing a build constant alone
cannot enable a migration. Historical manual materialization rechecks admission
after acquiring update ownership, so a completed concurrent handoff cannot leave
the earlier entry check as permission to rewrite old configuration.

The update-control Interface acquires an OS-held per-home write barrier and
rechecks the durable runtime floor while holding it. Its Node Effect Adapter
owns acquisition, typed failure mapping and release. Callers supply their actual
runtime context. Source development executions have no published version and
retain their existing development behavior; installed bundles always carry the
compiled identity.

Ordinary configuration transactions, Collector state, capture bootstrap metadata, journal creation and
each journal transaction, and source bindings use their existing Module
Interfaces. The implementation checks admission before starting a mutation and
again under the barrier at the final durable commit. Journal handles opened
before an upgrade are covered by the same transaction admission. Resource close
still runs; WAL checkpointing during close changes physical representation, not
the admitted logical data. Close normally shares the barrier; if its bounded
acquisition fails, the finalizer still closes the handle and reports the failure.
It must not become a reason to leak a database handle.

Lock order is an existing file/Collector lock, then the admission barrier, then
the short atomic file write or SQLite transaction. The barrier must not enclose
another Module's lock, network/npm work, a whole journal Scope, Collector waiting
or child readiness. Floor-changing fence and bootstrap-rebind commits use the
same barrier, rechecking their selection before committing. If an old write wins
the barrier it completes before the new floor; if the floor wins the old write
fails without changing capture data. OS ownership releases on process death.

The filesystem is a local-substitutable dependency, not a new mocking Seam.
Tests use real isolated homes and caller Interfaces. Keeping the barrier in the
deep update-control Module improves Locality and Leverage: deleting it would
spread synchronization, floor decoding and resource lifetime into each writer.

Stable control operations remain separate. User Stop must still cancel restart
intent, and an update owner must finish its bounded pause/resume handoff after
raising a floor. This decision does not apply a capture-data lease to those
operations or grant an environment-variable bypass. It does not retrofit guards
into already-published binaries.

## Scope and verification

Verify real configuration writes, first-time state/journal initialization,
already-open journal writes, historical bridge decoding, and both concurrent
write/floor orders. Existing manual update, forward recovery and Stop tests must
continue to pass. Package tests verify the installed executable identity and
bootstrap delegation.

There is no new v3 schema, migration plan, cross-contract catalog entry or Server
change in this increment. A future migration must separately define readable
contracts, candidate preflight, fenced apply and Server prerequisites. Remote
effects and stable credential/privacy/control protocols retain their existing
ownership; this barrier alone does not prove their migration compatibility.
The genuine 0.5.3 delivery limitation and native reboot/power-loss acceptance
remain as recorded in ADR-0107 and the current feature guide.
