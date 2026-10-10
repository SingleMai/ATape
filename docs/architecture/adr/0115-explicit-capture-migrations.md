# ADR-0115: Explicit capture migrations and forward recovery

Status: Accepted, 2026-10-10. Implementation and delivery evidence belong in the
current CLI guide; this decision does not establish package publication.

Extends [ADR-0104](0104-capture-v2-state-upgrade.md),
[ADR-0107](0107-independent-update-control.md),
[ADR-0108](0108-compatible-release-bundle-discovery.md), and
[ADR-0110](0110-runtime-writer-admission.md).

## Decision

Preserve the existing update-control v1 Interface, phases and executable reader
floor. Add a deep CaptureMigration Module with a separate strict requirement,
progress ledger and completion receipt. Old copied workers decode update control
before delegation and can rewrite it; adding an optional migration anchor there
would lose the anchor. Replacing that protocol would strand those workers.

The Module owns plan validation, registered account inventory, durable attempt
authority, target execution and replay. Its parent Node Adapter exposes Promise
operations; private target entries use Effect and run only at the executable
Composition Root. Filesystem and SQLite remain local dependencies. Authenticated
capability HTTP is the remote Seam; migration does not invent a Repository Seam.

The first compiled plan is `atape.capture-migration.v1 / journal-v7-to-v8`, from
capture contract v1 or v2 to actual contract v2, allowing stored formats 7 and 8.
The existing journal Module supplies the real transactional SQL through a narrow
migration Interface. Verified v8 is an idempotent no-op. Unknown plans and older
formats are rejected before pause, even if historical manual opening supports
other upgrades. No runtime identity or manifest is relabeled to claim support.

## Discovery and prerequisites

Keep strict bundle/catalog v1 unchanged. Add strict bundle/catalog v2 with an
immutable package set and explicit plan, and routes keyed by source contract,
control protocol, migration protocol and plan ID. Retain old plan routes while
advancing supported routes. New clients prefer the fixed v2 catalog; only its
initial absence permits v1 fallback. Persistent receipts detect changed bundles
and regressed catalogs. An independent descriptor namespace lets a real v2 bridge
serve both readers. Keep that bridge on historical GitHub/npm latest indefinitely;
incompatible targets must use nonlatest publication.

Actual target preflight is read-only, before pause. For enabled SourceCapture v2
projects whose persisted intent requests collection, verify publication/adoption
capabilities using existing credentials without device reporting. Do not import
Adapter factories, read provider history, adopt sessions or upload payloads.
Adapters may declare their SourceCapture v2 Server minimum through the optional
`publicationTargetProfile` manifest field. Existing undeclared packages retain
Profile2; Profile3 sources declare Profile3. Read-only preflight negotiates and
requires Profile3 only when an enabled candidate declares it, while retaining
the existing Profile2 and adoption requirements. Runtime header checks remain
authoritative. Importing factories would violate read-only preflight; hard-coding
provider names would spread capability knowledge outside the Adapter. A manifest
declaration keeps that knowledge local and binds it into the existing scope hash.
Stopped collection still permits local migration without a Server requirement.
Raw-off does not disable Canonical prerequisites. A shared local scope fingerprint
binds account, credential lineage, source capabilities, projects and wanted intent.
Recheck it under process ownership before publishing maintenance intent, then
recheck scope and journal inventory under config/state locks after pause.

Pending controlled-session creation proofs use a separate OS-held shared lease.
Each pending proof acquires it under the runtime writer barrier before its durable
attempt is written, and releases it after confirmation, abandonment or Scope
closure. Before advancing a reader floor, the updater must acquire exclusive
ownership under the same barrier. Busy proof leases defer the attempt before the
fence; they do not hold a global writer lock for an interactive session or wait
without a deadline. Confirmed sessions no longer delay updates. Process death
releases a lease; a pending receipt file alone is never ownership. Letting old
Hosts write past the reader floor would weaken admission, while killing an
interactive native child would interrupt the user. Deferring the fence preserves
the proof and keeps update attempts bounded without either exception.

## Durable boundary and recovery

Write bounded, owner-only, no-follow metadata at fixed paths under `updates`:
`capture-migration.required.json`, then `capture-migration.json`, each fsynced
before begin/fence. Duplicate the immutable requirement and its hash in the
ledger. Missing one peer, corruption or a mismatch closes capture admission;
known owned recovery can repair a missing peer from strict surviving evidence
and the matching outer boundary. Never infer completion merely from v8 files.
Both files deliberately removed by the local user are outside crash recovery.

After fencing, recovery always selects the verified target and resumes the same
plan. It never rolls back transformed state or bypasses recovery because updates
are disabled or collection was stopped. Preserve the latest Stop intent. Before
fencing, confirmed rollback may abandon the new requirement and restore its
nonrecursive prior completed pair. Every registered ready database must exist;
unexposed initializing accounts may remain deferred without creating a database.

Each target apply owns the fixed home-wide `capture-migration.apply.lock.sqlite`
through journal close and progress/receipt commits. A random durable attempt token
grants delegated authority. Parent death alone does not revoke it. A new recovery
owner rotates it under the existing short admission barrier before waiting for
the apply lock. Every SQL/progress/receipt commit rechecks token, outer key,
immutable target, selection and floor under that same barrier. A preceding commit
finishes before rotation; a revoked child cannot commit afterwards. Busy locks
defer recovery and never permit concurrent migration. Parent joins child exit;
bounded apply and maintenance deadlines leave durable retryable work.

Ordinary capture writers acquire one barrier for floor and migration admission
plus the actual write. Configuration retains floor-only admission because this
plan changes no configuration schema. Stop remains independent. A pending plan
blocks capture even if an old worker completed executable recovery. A completed
pair admits the same capture contract at or above the receipt's target version,
subject to the current floor. It does not permanently pin the old outer key,
bootstrap hash or Adapter slots, so later compatible updates/manual rebinding
remain possible. In-flight receipt checks still require the exact transaction.

## Consequences and limits

Crash recovery preserves journal bindings, Canonical/Raw obligations, receipts,
cursors and user preferences. Tests must exercise real SQLite and child processes
through caller Interfaces, including token revocation and commit ordering.
Physical file hashes are not completion evidence because WAL and later capture
legitimately change bytes. A hung synchronous SQLite operation may retain the
apply lock beyond a JavaScript deadline; safe retry waits rather than stealing it.

Immutable 0.5.3 cannot gain new discovery or OS wake behavior remotely. It needs
separate initial delivery, and an existing 0.5.4 installation enrolls OS wake only
after a capable entry actually runs. This mechanism covers capable installations;
it cannot promise delivery to unreachable machines or invent missing credentials.
