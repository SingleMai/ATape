# ADR-0104: Capture v2 state contract and explicit manual upgrade

Status: Accepted (2026-10-09)

Amends [ADR-0100](0100-managed-automatic-updates.md) and
[ADR-0103](0103-login-startup.md) for the first release containing
[ADR-0101](0101-claude-active-path-and-legacy-adoption.md).

## Context

The published 0.5.3 runtime accepts capture journal SQLite versions 1–7.
Claude current-path capture adds journal v8, frozen legacy checkpoints,
publication v2 metadata and irreversible Server adoption of legacy Sessions.
An older runtime cannot safely resume this resulting state. An old console's
ability to stop a new Collector does not establish capture rollback compatibility.

The automatic updater's existing Interface requires an exact local-state
contract before executing the candidate or closing collection admission.
Retaining the old contract would incorrectly authorize 0.5.3 rollback after
the new runtime opens an account journal. Publication authorization and a
manual staging waiver do not waive this compatibility invariant.

## Alternatives

Keeping SQLite `user_version=7` with additive columns would let an old reader
open the database, but would hide incompatible cursor, publication and remote
adoption semantics. Separate old/new journals would still share the Server's
irreversible legacy-write fence and require a new dual-writer protocol. Neither
provides the promised rollback; both reduce Depth by spreading compatibility
judgment across storage and provider paths.

An unattended cross-contract migration would need a new updater protocol with
a durable forward-only recovery boundary understood by the already-published
0.5.3 worker. That worker has no such Interface. Relabeling the new runtime
cannot add one.

Choose an explicit manual boundary and reuse the existing exact-contract Seam
for subsequent compatible updates. This keeps migration Locality in one Node
Module and keeps the automatic updater Interface unchanged.

## Decision

0.5.4 declares `atape.client.v3-capture.v2`; its updater accepts only that
contract. The genuine 0.5.3 worker rejects 0.5.4 during preparation, before
candidate execution, Adapter activation or Collector maintenance. Existing
0.5.3 collection remains selected. This release requires one manual CLI upgrade;
later v2-compatible releases retain automatic update and compatible rollback.

The supported transition is: use the old CLI to stop sync and finish recovery
of any pending update; close old consoles; install the new npm CLI; open the new
console. Do not use an already-open old console to complete this cross-contract
transition. Keep a consistent backup before migrating. Help and version queries
remain read-only and report the newly installed CLI without selecting a v1
managed runtime or performing migration.

A `manualStateUpgrade` Module handles only known v1 managed metadata at this
explicit interactive entry. Its Interface validates the known old selection
shape, acquires shared update and Collector-process ownership, requires stopped
collection and no pending update/maintenance, preserves the selected official
Adapter overlay in configuration, then retires v1 current/retained pointers.
Unknown metadata, live owners or unfinished old work reject the transition
without deleting state. Restore the old npm CLI to finish that work, stop it,
and retry. It never guesses an old recovery outcome.

A private bounded ledger is persisted before configuration/pointer changes.
Each step is idempotent and joined to the held ownership. An interrupted
transition completes before new runtime delegation or collection; it never
restores an older Adapter over a later deliberate configuration change.
Preferences, Projects, account bindings, capture files and Stop intent are
preserved. No capture journal is opened by this metadata transition.

SourceCapture v2 checks Server publication v2 target and legacy-adoption
capabilities before opening/migrating an account journal or replacing a legacy
global checkpoint. Missing capability leaves that source's local state unchanged
and reports unsupported capture. An Instance version string alone is not proof
of capability. Package publication neither deploys the Server nor authorizes it.

After explicit Start, the existing journal Module performs its forward v7→v8
transaction and the source Module owns the already-designed legacy adoption
workflow. After that boundary, recover through a v2 runtime and its journals;
do not downgrade to 0.5.3. Restoring only local files cannot undo Server adoption.
This release does not offer automatic or destructive v8→v7 conversion.

The new state contract also replaces the earlier same-contract 0.5.3-bootstrap
startup path. A v1 bootstrap cannot decode a v2 runtime pointer. 0.5.4 login
startup requires the manually installed capable v2 bootstrap; later compatible
managed releases can reuse it.

## Verification and limits

Verify through caller Interfaces: genuine 0.5.3 updater rejection of the v2
package; old selection/retained metadata transfer, interrupted replay and pending
rejection; read-only help/version; preserved Stop/preferences; genuine historical
v7 journal creation and forward recovery of Canonical/Raw obligations; no local
migration when Server capability is absent; and same-v2 update/rollback behavior.
Bind release evidence to the exact candidate and downloaded packages. Controlled
commands do not establish real login, reboot, power-loss or Linux cgroup behavior.
