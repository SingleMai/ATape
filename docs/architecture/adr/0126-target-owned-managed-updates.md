# ADR-0126: Target-owned managed update preparation and recovery

Status: Accepted

Date: 2026-10-13

## Context

Automatic updates should carry an installed official client forward without
requiring its user to understand provider, publication or journal versions.
ADR-0100 established that policy; ADR-0107 separated runtime selection from
capture state; ADR-0115 established explicit, fenced capture migration.

Published 0.5.10 still installs and decodes target Adapter manifests before
handing control to the target CLI. Its closed Canonical/publication profile
decoders reject new v5 packages. Its migration prerequisite fingerprint also
decodes manifests using the parent's Schema. Target preflight cannot repair a
failure that occurs before the target executes. Stopping collection does not
repair this dependency.

The retained npm bootstrap also returns to its own recovery Implementation when
the public update-control transaction is pending. A future capture ledger can
therefore reach the old decoder during recovery even after ordinary preparation
has moved to the target. Automatically replacing the global npm package would
add a write-permission requirement to updates that previously needed only a
writable `ATAPE_HOME`. A copied native launcher can recover, but its registration
or user service manager is not available on every supported installation.

Skipping checks, relabelling v5 output as v3/v4, changing published archives or
performing upgrades in an informational command would violate compatibility or
executable identity. Manual npm replacement is a recovery option, not the
normal automatic upgrade policy.

## Alternatives

| Interface | Depth and Leverage | Locality and limits |
| --- | --- | --- |
| Parent prepares every future Adapter and migration | Reuses the coordinator but exposes future formats to an old caller | Provider or journal evolution can require another user-assisted bridge |
| Every Adapter retains old and new projection modes | Old parents install a package; new clients select richer output | Permanently spreads upgrade compatibility through provider projection, replay and privacy |
| Parent verifies a target executable; target owns preparation, activation and recovery | Stable Interface hides package formats, server admission and migration | Concentrates future-format knowledge in its implementing executable; requires a durable handoff |

Select the third Interface. This is a real Seam between separately versioned
executable deployment units, implemented by a Node subprocess Adapter. It does
not introduce an Interface merely for mocking.

## Decision

### Stable update Interface

Introduce `atape.update-target.v1` and additive release bundle/catalog v3
namespaces. A v3 bundle binds the exact stable version, capture contract, update
control protocol, target execution protocol, supported source capture contracts
and complete immutable package identities. It does not expose the target's
private migration plan or prepared-state Schema.

The parent verifies the target CLI archive, immutable generation, entry
containment, executable digest and declared execution capability. It does not
install target Adapters or interpret target capture ledgers, prepared records,
Canonical profiles or server prerequisite bindings. The target owns those
operations through its existing deep update Modules.

Private executable operations are `prepare`, `activate` and `recover`. A bounded
durable request binds job identity/token, immutable bundle identity, executable
digest, baseline config/selection/bootstrap identity, automatic preference
context and an opaque prepared key. The target returns a bounded request-bound
durable receipt. Its private prepared records remain private. Informational
commands remain read-only.

A completed update retains a separate stable owner descriptor bound to the
selected immutable generation. Older callers also delegate recovery inspection
and protected-slot queries to that owner before reading completed private
ledgers. The owner descriptor carries no activation baseline, prepared key or
authority to start another upgrade. This avoids reintroducing old-parent
decoding immediately after the pending handoff is cleared.

The target checks its actual compiled identity, request, bundle and baseline
before work. Existing checks of current preferences, eligible installations,
credentials, server capabilities and scope still apply before pause/activation.
The current target may internally use its actual `journal-v7-to-v8`
Implementation. This is not a new migration plan and must not be advertised as
one merely to route updates.

### Ownership and recovery

Persist and sync the stable handoff before launching preparation. Its phases
distinguish preparation from activation; preparation does not pause collection
or advance a capture fence. Only one job owns the handoff.

The parent owns the existing updater worker lock. Target entries never acquire
that same lock; they acquire a separate OS-held target execution lock, avoiding
a parent/child lock deadlock. Effect owns the subprocess lifetime and joins
termination on cancellation. The durable handoff and target lock also cover
parent SIGKILL and surviving children. Existing migration apply authority and
its independent apply lock still protect fenced journal writes.

Recovery checks the stable handoff before any parent-specific capture recovery
decoder, then delegates to the exact recorded immutable target, never latest.
Busy ownership defers recovery without stealing locks using a PID or timeout.
The target uses its own recovery Implementation and reports completion only
after capture, control and maintenance recovery settles. The parent clears the
same job's handoff only after validating the receipt and reacquiring exclusion.
Successful completion syncs the new owner descriptor before removing the
pending handoff. Deferred preparation preserves the previous owner. An owner
that no longer matches the selected generation cannot route work backward.

Pruning and npm bootstrap replacement must defer or finish the handoff first.
They must not interpret unknown target slots to choose what to delete. Before
the existing fence, failure leaves or restores the old usable runtime. After
the fence, recovery moves forward with the same target. Stop and updates-off
remain current user intent; recovery does not turn sync on or authorize a new
update.

### Execution handoff before private migration

For target-owned updates, public update control records execution authority,
not private capture progress. The target validates and durably records its
private preflight authorization before changing that authority. Under update
ownership, Collector maintenance and the admission barrier, it publishes a
completed forward-only execution boundary and selects the verified target.
It does not expose public prepared/begun/fenced intermediate phases that would
route the retained bootstrap back into its old capture recovery decoder.

The completed boundary is synced before the runtime pointer changes. A crash
between those writes still leaves the previous capable bridge as the delegated
entry; that bridge reads the stable handoff and invokes its recorded target.
Recovery repairs the pointer using the same execution authority. The target
then authorizes and applies its private capture migration without starting a
second public pending transaction. The preflight source identity, inventory,
scope and exact target remain bound across the handoff; a completed boundary
alone is not permission to invent a migration authorization.

The Collector's existing readiness Interface can report local executable
compatibility while its admission loop waits for the stable handoff to be
durably cleared. This check precedes private migration decoders. Neither a
selected executable nor a completed execution boundary proves capture is
ready. Recovery covers interruption before private authorization, during
migration and before handoff completion. Existing Stop intent and the durable
maintenance gate continue to govern resumption. Ordinary updates do not rewrite
the global npm package or depend on native scheduling registration to recover.

An already registered scheduled-update job retains a copied executable. Its
0.5.10 admission path reads capture recovery before delegating, so the bridge
must refresh that owned, private launcher before target-owned preparation. This
operation preserves the registration, preference, token and descriptors; it
does not enroll a missing job or call the OS service manager. Existing journalled
launcher replacement keeps either the preceding or new verified bytes admitted
until the replacement is durable. Already running immutable old workers can
still fail closed on unknown private data; they must release ownership and must
not prevent the selected target's recovery or move public control backward.

### Genuine automatic bridge and durable discovery

Already-published 0.5.10 cannot be changed. Release 0.5.11 as a genuine bridge:
its CLI implements target-owned updates; official Codex/Claude Adapters retain
the actual released v3/v4 behavior. Shared CLI/Server support for newer data can
remain. Package declarations must match the bridge Adapter bytes and output.

The subsequent feature release restores v5 provider Implementations and is
selected through catalog v3. A 0.5.10 client automatically receives the bridge
through its existing route, then the feature release through the new route.
Legacy routes and the npm `latest` bridge target remain available for clients
returning after a long offline period. This is not a publication-order window.

Record an explicit `legacy-bridge` or `target-owned` publication channel in
release and packaged runtime identity. Same capture/control contracts alone do
not authorize advancing a legacy route. A target-owned release advances the
managed npm tag and v3 route, preserving legacy v1/v2 catalog bytes and npm
`latest`. It does not manufacture a legacy descriptor for unsupported packages.
Static export accepts its previous index and emits an index capable of versions
with only v3 descriptors, retaining historical bytes.

The v3 Interface is deliberately small, not a promise that no future bridge can
be needed. Changes to executable transport, Node platform, update control or
this execution protocol still require a real compatible path.

## Verification and delivery

Caller tests cover immutable/request identity, changed baselines/preferences,
Stop, target failure, interruption, exclusion and recovery before any parent
future-format decoder. Publication tests cover retained legacy routes/tags,
v3 immutable identity and export from old indexes.

Installed acceptance must use the authentic published 0.5.10 archive, a real
bridge artifact and a real feature artifact. It exercises automatic handoff,
continued capture, stable conversation/Raw identity and progress, and late
arrival through retained discovery. Controlled acceptance remains distinct
from live provider, OS login and production deployment acceptance.

This ADR records the decision. Current CLI/release guides record implemented
scope; candidate evidence records checks actually completed.
