# ADR-0067: Collector installation binding and capture journal bootstrap

- Status: Accepted implementation detail of ADR-0059
- Date: 2026-09-10

The Host preparation and recovery Modules require account-bound journals. The
existing Collector already owns an installation identity and legacy checkpoints
in its version-2 JSON state. Creating another installation identity or silently
replacing missing capture state would disconnect durable upload obligations.

## Interface and ownership

`CaptureJournals.open(account, limits)` returns the existing `CaptureJournal`
Interface in the caller's Effect Scope. The Node Adapter derives the installation
identity from the existing Collector state while holding its metadata lock. It
hides account filenames, versioned bootstrap, durable marker writes and storage
opening. Limits remain explicit inputs; this increment selects no release values.

The factory is a real local-storage Seam for dynamic account-bound resources.
Requiring callers to choose create/open and reconstruct paths would leak the
bootstrap state machine into scheduling. Eagerly opening every configured account
at startup would initialize unused storage and lose resource Locality. The selected
factory is lazy and registered in the CLI Composition Root; legacy collection does
not invoke it or switch write mode.

The existing JSON installation ID and checkpoint contents remain unchanged.
Collector state writes now sync the temporary file and parent directory around
the atomic rename, so a newly persisted installation does not depend only on a
buffered write before capture state becomes usable.

## Versioned local binding

Next to the configured Collector state file, `*.capture-installation.json` binds
the existing installation under `atape.capture-installation.v1`. `*.captures/`
contains account markers and SQLite journals whose filenames hash the instance
origin and user ID. Account metadata uses `atape.capture-account.v1` and repeats
the complete instance/user/installation binding; the SQLite journal verifies the
same binding independently.

The installation marker also maintains a bounded registry of at most 32 account
hashes and their initialization phases. It records an account before creating that
account's marker or database, and records readiness before exposing the journal.
An established account whose database and account marker both disappear remains
recognizable as lost storage; it is never treated as a new account. Unknown account
artifacts are rejected instead of adopted.

Each marker has an `initializing` or `ready` phase. Initialization writes the
binding before creating its resource. A database is created or validated and
closed before its account marker becomes ready; only then can the factory return
an opened journal. Restart can finish a never-exposed initializing resource. It
does not repair corrupt SQLite or accept orphaned WAL/SHM files as an empty source.

Ready markers never authorize replacement of a missing resource. A missing
database, directory or binding, an unsupported marker version, and changed
installation/account identity produce typed errors. If capture state exists but
the Collector JSON state is missing, ordinary Collector snapshot also refuses to
create a new random installation. Restore the existing matched state rather than
discarding recovery evidence. This is not an automatic migration of lost history.

All bootstrap changes and legacy checkpoint writes share an OS-backed SQLite
writer lock in `*.lock.sqlite`. The coordination format is versioned and bounded;
an established capture installation with missing coordination storage fails closed.
A process exit releases the SQLite lock without deleting a stale coordination
file. The old PID lock gate remains for already-running legacy Collectors, but
current writers serialize its stale-file inspection and removal under SQLite.
A pre-upgrade Collector must be stopped before a new binary writes this state.
The old gate only respects an older writer that already holds it: an older stale
lock reaper ignores SQLite and can still delete a newer live PID gate. Overlapping
old and new writers is unsupported, even with only one older process. The SQLite
lock guarantees exclusion among participants in this coordination protocol.

The entire metadata critical section is uninterruptible: Node filesystem Promises
cannot be canceled, so interrupting an Effect must not release the lock while an
old rename can still land. Acquisition retries contention for at most five seconds.
Initial Collector identity and first binding
creation additionally uses an atomic no-overwrite link, so a competing initializer
cannot replace identity metadata. Updates write bounded temporary files, sync them,
rename atomically and sync the parent directory. Metadata reads accept at most
4 KiB from regular non-symlink files. New metadata and journal files use `0600`;
the journal directory uses `0700`. Neither unredacted source nor credentials enter
these markers.

The factory releases the metadata lock before returning while keeping the journal
in its caller's Scope. Separate opened journals retain the existing local owner
epoch fencing. Two accounts share the Collector installation but have independent
source scopes, checkpoints and retained-content budgets.

## Evidence and remaining work

Tests use real filesystem state and SQLite through the factory and journal
Interfaces. They preserve an existing legacy checkpoint byte-for-byte, reopen
pending frozen bytes, check account isolation and resource closure, exercise owner
fencing, reject changed/lost bindings and established databases, and resume only
valid incomplete initialization. Four independent Node processes concurrently
perform their first open and claim, with and without a stale legacy lock; they establish one installation/database and
four distinct owner epochs. A separate Node fault fixture pauses identity fsync,
interrupts its Effect and starts another factory caller; neither interruption nor
second open completes before the original write settles, and identity is preserved.
Independent process-kill experiments also verify recovery while holding the lock
and before first identity publication. Existing Collector and journal behavior
tests also run.

These tests establish process-restart behavior on the tested runtime. They do not
replace power-loss, filesystem stress or supported-OS acceptance. Durable directory
sync must be supported by the runtime/filesystem; failures remain explicit.

The next increment selects the explicit Adapter source capability and connects
discovery, attribution, scheduling and source-free recovery. OpenCode remains
private and unregistered, with no package publication or deployment in this change.
