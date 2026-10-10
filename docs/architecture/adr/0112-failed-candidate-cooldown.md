# ADR-0112: Persistent cooldown for failed update candidates

Status: Accepted (2026-10-10)

Extends [ADR-0108](0108-compatible-release-bundle-discovery.md). This decision
remains within same-capture-contract updates and does not establish publication.

## Problem and alternatives

Global retry backoff eventually attempts the same candidate again, repeatedly
pausing working collection. Parent-observed child exit or readiness timeout does
not prove a permanently broken release: child-side disk, permission and resource
failures can look identical.

Two materially different Interfaces were considered:

1. Permanently quarantine a bundle after any startup failure and successful
   rollback. This can strand installations after transient machine failures.
   A trustworthy permanent verdict would need additional bounded, authenticated
   candidate rejection evidence; existing readiness does not provide it.
2. Persist a finite cooldown for the complete immutable bundle after a narrowly
   classified local candidate startup/readiness failure and confirmed fallback
   readiness. This is selected. First failure waits 24 hours, the second 72 hours,
   and subsequent failures seven days. Expiry permits an unattended retry.

## Interface and invariants

The existing AutomaticUpdatePlatform Interface receives the automatic/manual
mode at preparation as well as activation. Its Node Adapter checks cooldown
before preparation and again before maintenance ownership can pause collection.
Manual invocation validates the same metadata and bypasses only that candidate's
cooldown for this attempt, retaining all ordinary compatibility, integrity,
ownership and policy checks. It does not
delete failure history before success.

The Collector maintenance Module exposes a structured candidate-readiness
failure only after a real candidate launch, successful recovery callback,
actual fallback readiness and release of the maintenance gate. It preserves the
existing typed process-error Interface. Process identity uncertainty, filesystem
I/O, stop failure, pre-launch deadlines and activation/configuration failures do
not receive this classification. Stop can suppress restart; a stopped fallback
is not evidence of fallback readiness. Recovery failure retains the existing
gate/ledger and never authorizes cooldown or another candidate.

The managed-update Implementation additionally verifies restored selection and
completed durable recovery before recording cooldown. It stores the validated
complete bundle, failure count, phase and bounded timestamps in an atomic,
synced per-home metadata file under existing update ownership. At most 64 recent
bundle records are retained. Corrupt records fail closed for new managed-update
attempts, including manual attempts, while ordinary CLI/collection and recovery
remain available.

The key is releaseBundleFingerprint, including every package and both contracts;
catalog revision is not identity. Another family's catalog publication cannot
clear cooldown. A new eligible bundle remains independently eligible. Successful
activation clears only that bundle's record. Uncertain child-side disk failures
can receive finite cooldown but are never classified as permanently bad code.

The application Module treats an active cooldown as an ordinary no-update check,
preserving the normal 24–30 hour discovery schedule and resetting global retry
failures. New releases remain discoverable during cooldown. Network/preparation
failures keep the existing transient backoff. Forced/manual attempts do not
swallow unexpected cooldown rejection.

This preserves Depth and Locality in the existing update and maintenance Modules;
deleting them would spread readiness attribution, durable identity and recovery
ordering into CLI presentation and Collector callers. The filesystem is a
local-substitutable dependency, not a new mocking Seam. Clock-driven behavior is
tested through the same Interface with real isolated homes.

## Verification and limits

Verify persistence across new Adapter instances, no repeated preparation or
Collector pause during cooldown, new-bundle eligibility, expiry and escalation,
manual retry and successful clearing. Verify prepare/transport/I/O/identity,
configuration races, Stop and pending fallback recovery do not produce cooldown.
Exercise both historical v2 and independent update-control rollback.

This does not provide permanent quarantine, cross-contract migration, remote
health acceptance, independent periodic OS wakeup or cleanup of release files.
Already-published old updaters do not gain cooldown retroactively. Package
publication, Server deployment and native reboot/power-loss acceptance remain
separate scopes.
