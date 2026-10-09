# ADR-0107: Independent update control and durable runtime admission

Status: Accepted (2026-10-10)

Amends [ADR-0100](0100-managed-automatic-updates.md) and the future upgrade
mechanism described by [ADR-0104](0104-capture-v2-state-upgrade.md). The published
0.5.3 → 0.5.4 manual boundary remains historical fact. The
[setup guide](../../cli/setup-and-adapters.md#upgrade-the-cli-and-adapters) owns
implemented scope; acceptance of this design does not establish publication.

## Problem and alternatives

The updater currently uses one exact capture-state contract for both executable
delegation and data compatibility. A data-contract change therefore disables the
only automatic delivery path that could install a migration-capable updater.
Selecting an older executable after an irreversible local or Server migration
would also be unsafe. Code rollback and data recovery are different operations.

Two materially different Interfaces were considered:

1. A permanent supervisor owns release discovery, Collector lifetime, migration
   and recovery. This gives one always-present control owner, but changes login,
   cgroup and Stop ownership together and needs native OS lifecycle acceptance.
2. A short-lived coordinator owns a durable update-control Module. The stable
   bootstrap delegates before constructing the capture runtime. The coordinator
   prepares immutable generations, quiesces through the existing bounded
   Collector Interface, and atomically selects a generation. This is selected.
   It preserves existing ownership and bounded handoff while separating capture
   compatibility from the control protocol. Independent periodic OS wakeup is a
   subsequent increment, not implied by this decision.

## Interface and invariants

The application continues using prepare/activate/recover through its existing
Effect Interface. A private Node update-control Module hides validated selection,
durable transaction phases, conditional recovery and reader-floor admission.
Its filesystem dependency is local-substitutable; tests use real isolated homes
through the same Interface. Promise filesystem calls remain inside the Node
Adapter and enter the application as typed Effects. No test-only Seam is added.

`atape.update-control.v1` is independent of an opaque capture-state contract.
`updates/runtime.json` selects the complete CLI and official Adapter generation;
`updates/control.json` records recovery intent. Both use bounded Schema decoding,
atomic replacement and file/directory fsync. Generation containment, package
version, actual declared capture contract and bootstrap identity are checked.
All mutations run under existing OS-held update ownership. User Stop remains
separate from maintenance intent and is never inferred from process liveness.

A transaction begins only after the Collector is quiescent. Before an irreversible
boundary, failure may restore the validated previous compatible generation.
Before admitting an incompatible executable or migration, the coordinator must
persist its complete recovery generation and monotonic reader floor. After that
boundary recovery moves forward through that generation; it cannot select the
old runtime. An unknown or malformed ledger fails closed. Conditional recovery
does not overwrite a later deliberate selection. A floor binds capture contract
as well as version: SemVer alone never proves data compatibility.

The bootstrap resolves the control pointer before capture admission. Admission
applies to the actual runtime performing capture, not to the older bootstrap
which must be able to launch recovery. Private worker and login entries retain
their existing ownership/admission checks. Pending legacy updates must finish
before the new coordinator can own a transaction or mutate capture state.

This gives Depth by hiding crash recovery and compatibility admission from CLI
and Collector callers; deleting the Module would spread those rules into entry,
configuration overlay and update activation. Locality keeps capture migration in
the owning journal/source Module, rather than in the launcher.

A deliberate manual npm replacement uses the same update and npm-installation
ownership. It preserves the selected Adapter installations before replacement,
verifies the new bootstrap directly, and snapshots its actual bundle into an
immutable generation. Only the same exact capture contract and a non-downgrade
may rebind an existing independent selection. Rebinding first persists a fenced
forward recovery target and reader floor, then replaces the pointer and completes
the ledger; it never clears an established floor or falls back to the overwritten
npm executable. The existing bounded application pause/resume owns Collector
handoff and user intent. After npm succeeds, cancellation joins verification and
rebinding. Startup detects an identity change left before the first rebound
ledger write and repeats the same owned, bounded verification and forward repair;
the coordinator materializes the old Adapter overlay before selecting its new
snapshot. Unknown, downgraded or incompatible bootstrap replacements remain
closed. npm replacement and the ledger write remain separate operations; restart
recovery repairs their gap rather than treating npm replacement as atomic.

## Legacy entry and delivery limits

The legacy `releases/current.json` remains a genuine capture-v2 bridge for an
already-installed 0.5.4 bootstrap. Later capable generations use the independent
pointer; they never relabel an incompatible package as v2. An old copied updater
cannot overwrite this control selection. The first implementation admits only
same-capture-contract updates. A future cross-contract plan must explicitly
declare readable contracts, migration ordering and Server prerequisites before
the coordinator can cross its recovery boundary.

Both published 0.5.3 and 0.5.4 query the same GitHub `latest` endpoint and install
the same immutable npm package version, but demand mutually exclusive manifest
contracts before candidate execution. One release cannot satisfy both. A
temporary bridge window does not serve indefinitely offline clients. The new
mechanism can be delivered automatically to the v2 cohort; the v1 cohort needs
a separately designed persistent bootstrap path. A stopped 0.5.3 installation
also has no OS wakeup. This decision does not claim either limitation is solved.

Subsequent delivery work must use persistent version-aware release discovery,
exact CLI/Adapter versions and publicly retrievable package verification before
advertising a release. It must not rely on briefly pointing `latest` at a bridge.

## Verification

Exercise caller-visible behavior: bootstrap-to-control delegation, complete
Adapter overlay, interrupted begin/fence/commit, pre-boundary rollback,
post-boundary forward recovery, malformed and escaping generations, old runtime
admission, manual bootstrap replacement, competing updates and user Stop.
Historical package fixtures must use genuine published bytes; controlled
filesystem tests do not prove reboot, power-loss durability or native cgroups.
Implementation, integration, package publication and Server deployment remain
separate evidence and authorization scopes.
