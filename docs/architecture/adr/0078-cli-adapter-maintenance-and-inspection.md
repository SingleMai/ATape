# ADR-0078: Isolated Adapter maintenance and bounded CLI inspection

- Status: Accepted
- Date: 2026-09-11

## Installation Interface and alternatives

AdapterPackages remains the external npm/filesystem Seam. Its install operation
prepares a validated, inert package in a unique directory and returns an opaque
packageSlot alongside package identity. Client management activates that slot by
atomically replacing configuration after an optimistic check of the installation
it originally inspected. Downloads and npm work do not hold the configuration lock.
This adds Depth: callers never orchestrate directory replacement or npm rollback.

Replacing the shared npm tree and attempting rollback was rejected: a running
Collector can read partially replaced files, and a crash between filesystem and
configuration updates requires a second recovery protocol. An immutable slot plus
one configuration pointer makes the existing atomic configuration update the only
activation point. Old runtimes retain their original files; later cycles read the
new slot. Unrelated configuration changes are preserved, while competing changes
to the same Adapter fail the optimistic check.

Local directories are installed with npm's install-links option so their contents
are copied instead of linking a mutable checkout. Lifecycle scripts remain off.
The package manifest and canonical entry path are checked before a slot is returned.
Invalid or cancelled preparation removes its private directory after npm exits.
Validated but unselected slots and previous slots are retained: automatic garbage
collection requires runtime leases and is outside this increment. Existing records
without a slot keep their original installation path until explicitly upgraded.
No old package tree is modified or implicitly migrated.
An already-running Host from an older CLI cannot interpret a slot. Built-in CLI
upgrade restarts managed collection; direct package-manager updates must restart
the Host before using the new Adapter maintenance flow.

## Collection and inspection

Every legacy Canonical and Raw transport request includes the Project's user ID
at the authenticated HTTP Interface. A changed credential fails before upload,
including on retries. It does not change the provider package or wire protocol.
The legacy Collector also preserves confirmed Canonical progress in checkpoints,
independently of Raw, under the registration binding established in ADR-0075.
An older Raw-off checkpoint without this fact gains it on its next confirmed
Canonical upload; cursor contents are not used to invent historical proof.

For console inspection, returning every full checkpoint or repeatedly querying
individual checkpoints was compared with a compact batch of captured scopes.
The existing CollectorStateStore gains a capturedScopes operation: one consistent
read returns only account, registration and Adapter identities with confirmed
history. This preserves Locality of storage interpretation and prevents the
Presentation from opening capture journals or learning private cursors. The
Implementation still uses the existing state lock and initialization safeguards.

## Official catalog

A small internal Adapter catalog owns names, package identities and pure native
location resolution. Its default entry contains only platform-neutral metadata;
the Node entry implements filesystem path semantics shared by the CLI and all
three provider packages. This is shared Implementation, not another runtime Seam.
It improves Locality and Leverage by removing duplicate defaults and the CLI's
cross-directory import of private OpenCode source. Putting provider paths in the
application/domain layer or loading installed provider code during setup was
rejected. Detection still reads file metadata only, and runtime compatibility
continues to come from the installed package manifest.

## Verification and delivery

Regression tests exercise installation and collection through their caller
Interfaces, using real local packages, persisted configuration and state, and
controlled HTTP at the remote Seam. They cover rejected and cancelled updates,
concurrent configuration changes, account changes between requests, Raw-off idle
cycles, and isolation of captured history by registration and enabled Adapter.
CLI package verification checks the bundled executable. Package publication and
Server deployment are separate actions and are not part of this increment.
