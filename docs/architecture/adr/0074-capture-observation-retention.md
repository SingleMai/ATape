# ADR-0074: Retire superseded capture record membership

- Status: Accepted implementation of the owner-approved metadata cleanup scope
- Date: 2026-09-11

The owner accepted safe metadata cleanup before ordinary OpenCode enablement.
The measured 10,000-Event Raw-enabled capture retained 60,229 metadata entries;
each subsequent complete observation adds at least 30,003 membership rows even
when Raw units are reused. Keeping every membership duplicates whole histories.

## Interface and alternatives

Keep retention inside the CaptureJournal Module, through
`pruneRecords(owner, limit = 100)`. One fenced transaction removes at most 100
membership rows from one terminal, superseded observation and returns the count.
The Collector drains these bounded operations under its existing source deadline,
yielding between transactions. Recovery and cleanup precede fresh admission and
do not depend on the source still existing. No new Seam or background worker is
introduced. This gives the journal Depth and keeps reachability rules Local.

Deleting entire completed captures was rejected: immutable reservation/seal and
unit receipt replay, version provenance, and borrowed Raw units still need their
identities. TTL deletion was rejected because age does not establish completion.
Keeping all membership until capacity was rejected for normal ongoing use.
Selective membership retirement removes the dominant repeated cost while
preserving those compact identity and recovery records.

## Reachability and replay

Protect all preparing, sealed and activated captures, and the scope's three
roots: published Canonical, observed Canonical and complete observed Raw.
Only completed or explicitly abandoned captures outside those roots qualify.
The root/owner check, retirement marker, bounded deletion and metadata accounting
commit together. Partial retirement resumes after interruption with no cursor
or stale reachability snapshot supplied by callers.

Retain all source version rows, capture headers, seals, activation/rejection
receipts and unit identities/dispositions/receipts. Source versions retain their
original version capture and Event Raw reference. Absence comparison uses the
protected complete observation. Raw reuse reads the protected latest observation
and follows its flattened unit binding to the retained original unit; it does
not need the original owner's obsolete full membership. Pending Raw remains
independent of the current Canonical head and is never resolved by cleanup.

`inspect` reports `recordsRetired`. Once retirement begins, historical record
lookup, pagination and record/binding replay fail explicitly with `state`, even
if a partial batch remains. They must never expose an incomplete membership as
an empty or complete source observation. Reservation, identical seal, activation
and unit receipt replay retain their original behavior, including conflicts on
changed proof and no restoration of an old checkpoint. This is an explicit
lifecycle boundary for local observation membership, not deletion of Server
Canonical history or Raw objects.

## Storage and scheduling

Journal format 7 adds a retained-membership count, a retirement marker and an
index of terminal captures with remaining rows. Upgrade verifies binding before
initializing counts from the previously complete record count. No rows are
removed during upgrade. Older Collectors must stop before the upgrade; mixed
format writers remain unsupported.

Cleanup works at or below exhausted admission because it allocates no metadata
rows. The existing transactional accounting triggers credit every removed row.
Current and pending memberships can still exceed admission; in that case retain
them and report capacity. Capture headers, unit proofs and distinct source keys
still grow and remain charged. This increment reduces historical amplification;
it does not promise constant storage, select release defaults, automatically
shrink SQLite files, expire receipts or publish/enable OpenCode.

## Verification

Exercise the public Interface over real SQLite: bounded interrupted retirement,
owner fencing, protected current/observed/pending captures, old receipt replay,
monotonic revisions after absence and abandoned observations, borrowed Raw after
retiring its original membership, and transactional capacity reuse. The actual
Collector must sustain repeated source rewrites under an unchanged metadata
budget that would fail with retained historical memberships. Existing native
installed CLI/Adapter HTTP/PostgreSQL acceptance must still pass.
