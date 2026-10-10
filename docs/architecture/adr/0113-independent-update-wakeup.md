# ADR-0113: Independent periodic update wakeup

Status: Accepted (2026-10-10)

Extends [ADR-0107](0107-independent-update-control.md). This decision adds an OS
wakeup for the existing update coordinator. It does not establish publication,
cross-contract migration or reboot acceptance.

## Problem and alternatives

An installation with stopped collection, a closed console or login startup off
has no owner to retry a due update. Login may also occur offline or before the
saved retry time. A later network recovery then needs user intervention.

Two materially different Interfaces were considered:

1. Extend login startup into a permanent supervisor. This couples independent
   update permission to collection lifetime and adds continuous supervision.
2. Register a separate periodic, short-lived update coordinator. This is chosen.
   The UpdateWake Module owns preference reconciliation and observed registration;
   its Node Adapter hides native registration, private launcher identity and OS
   lifetime. The existing AutomaticUpdates Module retains discovery, due times,
   backoff, ownership, activation and recovery. This preserves Depth and Locality
   without a second update policy.

## Interface and lifetime

The automatic-update preference alone controls registration after tool setup;
login-startup preference and Collector desired state are independent. Settings
persists the preference before reconciliation. A queued job rereads the current
configuration before new work. Disabling removes future scheduling without
terminating an in-flight update. If an update owner or pending recovery exists,
the trusted timer temporarily remains for recovery only. After owned recovery
finishes it removes future scheduling. This decision is serialized with update
ownership so disable cannot miss a not-yet-persisted handoff. Recovery of
previously admitted work remains allowed after automatic updates are disabled.

macOS uses a separate user LaunchAgent with RunAtLoad and an hourly calendar
minute derived from the canonical home. Calendar scheduling coalesces a missed
sleep wakeup. Linux uses a user systemd timer with an hourly calendar and
Persistent=true, targeting a oneshot service with RemainAfterExit=no. No sudo,
linger, root service or collection Start is introduced. The wake only checks
local due state each hour; normal discovery remains every 24–30 hours with the
existing transient backoff.

The native entry admits an owner-only token and retained bundled launcher,
recovers under the existing OS-held update ownership, delegates to a capable
selected runtime after releasing parent ownership, and joins its update work.
It never launches a detached updater. All registration commands and maintenance
operations retain explicit time limits. Native private files share the existing
owned, bounded, no-follow and synced-write implementation with login startup;
the OS manager is a real Seam, not a test-only abstraction.

The Linux wake service deliberately uses KillMode=process. A successful updater
may resume the independently owned Collector, which remains in the inherited
service cgroup. KillMode=control-group would kill that resumed Collector when the
short wake completes; RemainAfterExit=yes would prevent later timer activations.
Only the Collector may survive the joined wake; its token/PID lock and durable
Stop intent retain ownership. Owned npm/probe/update subprocesses remain joined
and bounded. The service does not disable normal user-manager shutdown cleanup.
This scoped lifecycle choice requires native repeated-activation and Collector
survival acceptance; descriptor parsing or controlled commands alone do not prove
cgroup behavior.

## Verification and limits

Exercise default-on setup, disabled startup with enabled updates, Stop preservation,
queued preference changes, offline backoff, pending recovery after disable,
competing wakeups, unavailable managers, retained launcher delegation and foreign
or symlink rejection through caller Interfaces. Installed-package checks must
exercise the private headless entry. Record real native manager acceptance
separately from command-Adapter tests and syntax checks.

The machine must be awake with its user manager available; shutdown and removed
Node installations cannot execute JavaScript. Missed scheduling is retried after
the manager returns. Windows, remote maintenance and log recall remain outside
this increment. Already-published binaries gain no new OS registration until a
capable release reaches and runs on the device.
