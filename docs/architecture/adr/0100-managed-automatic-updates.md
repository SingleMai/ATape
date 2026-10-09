# ADR-0100: Managed automatic CLI and official Adapter updates

Status: Accepted

Login startup is amended by [ADR-0102](0102-login-startup.md); the original
increment's lack of OS supervision below remains its recorded scope.

Date: 2026-10-09

Amends [ADR-0044](0044-cli-self-upgrade.md) for managed installation and
automatic updates. Existing custom-source Adapter maintenance and installation
leases remain governed by [ADR-0078](0078-cli-adapter-maintenance-and-inspection.md)
and [ADR-0080](0080-cli-input-and-adapter-slot-lifetime.md).
The [setup guide](../../cli/setup-and-adapters.md#upgrade-the-cli-and-adapters)
owns current implementation scope and recovery; acceptance of this decision is
not release, publication or deployment evidence.

## Context and constraints

Collection is intended to continue after initial setup with little user attention.
ATape therefore needs to update its CLI/Collector and installed official registry
Adapters without depending on a terminal session staying open. A running Collector
can always have more history to collect; waiting for all collection to finish is
not a reliable maintenance window. Collection checkpoints, account-bound journals
and idempotent delivery already permit interrupted work to resume.

All public npm packages use the same release version. A partially published set
must not be selected for automatic installation. Custom packages, local packages,
archives and URL installations retain their chosen source. Automatic updates do
not grant permission to capture additional tools or Projects. Local diagnostic
log recall and upload are outside this decision.

## Interface and alternatives

1. Keep an npm global installation and update it in place from the Collector.
   This has a small acquisition step but couples updater lifetime to the replaced
   executable, exposes readers to file replacement, and cannot provide a retained
   runnable old installation after interrupted npm work.
2. Run an independent updater but continue replacing the npm global tree. This
   improves process lifetime and restart ownership, but rollback still depends on
   npm's best-effort recovery of a tree being changed in place.
3. Keep npm as the bootstrap distribution, run a short-lived independent updater,
   and prepare immutable version directories before atomically selecting one.
   This is the selected design. One update Module hides release selection,
   acquisition, scheduling, installation ownership, bounded process handoff and
   recovery behind policy/status, trigger and preference operations used by CLI
   and Collector callers.

The selected Interface provides Depth: callers express an update preference or
request a check, rather than orchestrating npm, process signals and recovery.
Deleting the Module would spread those decisions across the CLI and Collector.
The external GitHub/npm/process/filesystem dependency is a real Seam; its Node
Adapter owns package-manager and OS details, with controlled external Adapters
and real temporary filesystems used for behavior tests. Presentation translates
intents and renders status. Effect owns side effects, typed failures, cancellation
and resource lifetime. This preserves Locality without adding a general-purpose
remote maintenance framework.

## Release selection and managed installation

New setup enables automatic updates by default and exposes a persistent switch.
Disabling it prevents subsequent automatic work; it does not erase installed
versions or change capture selection. Recovery of a previously persisted handoff
is independent of this preference and the new-upgrade schedule. Manual checks
and updates remain available.
An existing saved preference is preserved.

The final, non-prerelease GitHub Release is the completed-publication signal.
The release workflow creates it only after every package for version V has been
published and verified. The client chooses V once and verifies the exact
`@atape/cli@V` and every official Adapter `@V` in the official npm registry,
then prepares only the eligible Adapters already installed. Preparation and retry
remain pinned to V; the updater never resolves
each package's `latest` separately. Missing packages or failed validation leave
the current selection usable. Versions are stable SemVer and never downgraded.
An eligible installed package with an unknown or prerelease version makes the
whole bundle ineligible rather than attempting an unsafe ordering comparison.
The worker's compiled version is not installation authority. Preparation and
activation re-read the actual bootstrap's stable version and executable identity
so a copied old updater cannot downgrade a newer installed bootstrap.

The initial support scope is managed npm-global bootstrap installations on macOS
and Linux using the official registry. The installed npm executable remains the
stable entry and can delegate to the current managed CLI. Preparation installs
the CLI below `ATAPE_HOME/releases/<V>/` and prepares official Adapter slots
without mutating the old trees. An atomic current descriptor selects a complete
CLI/Adapter generation. The bootstrap entry and fallback identity are retained
explicitly; the original npm global tree is not treated as a rollback copy.
Custom packages and official packages installed from a local directory, file,
archive or URL keep their original source until an explicit source change.

Version equality alone does not prove state compatibility. Retained-version
rollback requires a shared supported local-state contract. Updates must validate
that contract before activation; unsupported changes remain a manual operation
until a migration design exists. State compatibility, Server capability and
provider compatibility checks remain release obligations.

Package metadata and entry containment are checked in the owning process, but
foreign import and factory-export checks run in an isolated child supervisor.
An in-process Effect timeout cannot stop a synchronous loop or safely release a
package lease while its import continues. A direct import in a child alone also
cannot detect a dead parent while that child's event loop is blocked. The child
therefore imports in a terminable thread, leaving supervision responsive to its
ten-second batch deadline and parent IPC disconnection. Termination has a further
one-second force limit. A structured result and parent acknowledgement precede
successful child exit, so an Adapter's early exit is not a readiness proof.
The owner joins child exit before releasing leases on ordinary cancellation.
No provider factory is invoked, and isolation is not a security sandbox.

## Scheduling and bounded handoff

An already-running Collector and opening the CLI can trigger a due check. Checks
use a daily cadence with jitter; failures retain a bounded retry/backoff schedule.
They spawn one independent, short-lived updater from a retained directory outside
the tree being replaced. A cross-process maintenance lock excludes competing
workers and activations. No OS boot/login supervisor is introduced in this
increment. An offline device or a machine with neither CLI nor Collector running
waits until a later trigger.
Not-due triggers return after local schedule inspection without starting npm.
Ownership-probe failures remain retryable on later triggers.

Manual CLI replacement and automatic updates share one OS-held update lifetime
per `ATAPE_HOME`, including preservation of selected Adapter records and Collector
handoff. Manual npm replacement also holds installation-wide OS exclusion for
different homes sharing that global tree. Collector handoff ownership is separate
from its short process-transition lock so user Stop remains available. Lock-file
existence, age and diagnostic PIDs do not establish ownership; process exit releases
exclusion without stale-file deletion or PID-reuse inference.

Preparation runs while old collection remains usable. Before activation, the
updater persists update intent and closes admission of new collection jobs. It
requests cancellation of the Collector and allows a fixed grace period for
checkpoint writes and resource cleanup, then escalates termination. Process
identity checks, signal delivery and exit confirmation share a total deadline;
an unconfirmed exit aborts activation. No collection backlog can extend the
maintenance window indefinitely. The updater selects the prepared generation
only after confirming the old owned process has exited.
The candidate records its original Adapter installations and selected generation;
activation rechecks both. A concurrent change invalidates preparation, and
conditional recovery never overwrites a later deliberate selection.

Activation has a 45-second monotonic workflow budget; recovery has a separate
30-second budget. Process lock waits are capped at ten seconds and all remaining
process/readiness waits are capped by the workflow deadline. An expired entry
resolution or configuration lock cannot proceed to a late spawn or selection
commit. Local OS filesystem calls are joined and checked after completion rather
than raced against a timer that could leave a later pointer write running.

Restart preserves interval and concurrency and checks local readiness: the new
runtime must load configuration, eligible Adapters and collection scheduling.
Network availability or newly collected conversations are not readiness
conditions. Unacknowledged delivery resumes from the existing checkpoint/journal;
idempotency handles a server acknowledgement lost before local persistence.

Maintenance pause and the user's desired sync state are separate durable facts.
An update may resume only collection the user still wants running. Stop during
an update cancels restart intent; closing the TUI does not. The maintenance lock
does not become an indefinite permission to restart user-stopped collection.

## Recovery, verification and limits

Durable intent distinguishes preparation, pause, selection and readiness. A worker
or machine crash can be reconciled when the CLI reopens or a later automatic
trigger runs. The old complete generation remains available until the new one is
ready; readiness failure restores it only when its state contract remains
compatible. Prepared/retained files must not be removed while current or in use.
The initial increment does not require automatic release-directory garbage
collection. Disk usage and unavailable npm/GitHub remain observable local update
failures rather than collection resets.

Verification must call the same update and Collector Interfaces as production
callers. Required behavior includes exact-version package selection, partial
publication rejection, disabled preference, competing workers, interrupted
preparation, bounded termination of an uncooperative Collector, exit-confirmation
failure, user Stop racing activation, retained-version recovery, and checkpoint
preservation. Regression checks must also cover old workers facing newer actual
installations, manual/automatic exclusion through handoff, SIGKILL releasing
ownership, PID-reuse recovery, auto-off recovery, and transient probe retries in
one long-lived runtime. Installed-package checks must exercise bootstrap delegation and
the independent worker outside the checkout, including stuck preflight imports,
updater death, unchanged running collection on preparation failure and a healthy
retry after ownership is released. Record checks actually run and any
unverified platform or crash scenario in the current feature guide or candidate
evidence. This ADR does not claim those checks have passed.

Package publication, Server deployment, database migration, reboot supervision,
remote commands and local log recall are separate work and authorization scopes.
