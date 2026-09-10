# ADR-0066: Host Raw preparation and receipt-aware reuse

- Status: Accepted implementation detail of ADR-0059 and ADR-0062
- Date: 2026-09-10

The Host can prepare Canonical replacements, and the journal can track independent
Raw obligations. Source callers still need a bounded operation that turns actual
rows into masked archive bytes and preserves existing provenance across observations.

## Interface and Depth

`preparePublicationCanonical` accepts explicit Raw limits when its persisted Begin
enables Raw. `prepareRawObservation` accepts a previously begun, tracked independent
observation and a lazy scoped source. Both verify fresh Origin and own the source
lifetime. No content request occurs while reading source rows. Final validated wire
bytes enter the journal; source closure precedes the local seal. Recovery retains
its existing source-free Interface.

The internal Raw preparation Module hides masking, versions, packing and reuse.
Keeping these policies in each provider Adapter would duplicate security and
publication semantics. Packing an entire observation would lose bounded memory;
one object per row would unnecessarily multiply HTTP requests. The selected
Implementation holds at most 100 records in one admitted object. It accounts for
each encoded member once and verifies actual encoded size at flush.

`CaptureJournal.recordStatus` adds indexed point lookup through the existing real
storage Seam. It returns the same metadata and receipt-derived outcome as paged
`records`. Chronological source reads therefore require bounded indexed lookups,
without repeated full scans of hash-ordered record membership. No schema migration
or new service Seam is needed.

## Masking and object identity

The versioned `atape.host-raw.v1` envelope contains the source/transform profile,
observation time and a map from hashed native record keys to allocated revisions
and actual masked rows. JSON TEXT retains its original representation when masking
does not change it. The shared SecretRedactor inspects decoded string values and
credential-key context, including nested JSON TEXT and Unicode escapes. Valid JSON
is token-scanned for duplicate decoded keys before traversal: JSON.parse alone
would silently discard earlier values and could miss an escaped secret. Ambiguous
members or collisions after masking produce a redaction gap. The traversal admits
32 levels, 100,000 nodes/tokens and 32 MiB of aggregate visited string/key bytes;
exceeding these bounds produces a limit gap. No unmasked source value is persisted.

Each content object is at most the explicitly admitted size, never above 3 MiB.
Final Base64 wire bytes also obey an explicit limit at most 5 MiB, aggregate Raw
wire bytes and unit count. A record that does not fit becomes an explicit limit
gap; remaining Canonical preparation continues. Journal exhaustion still fails the
entire unsealed capture, preserving earlier published coverage. These logical
budgets do not establish a process RSS or filesystem ceiling.

Raw fingerprints cover masked row semantics and their profile. Observation time,
allocated counters and object identity do not cause source revisions. A redaction
gap fingerprints its reason rather than retaining unsafe content. Object IDs hash
the versioned profile, original capture identity and unit ordinal; each object has
one immutable final generation-1 chunk. The JSON pointer uses the hashed record
key, so provenance remains reconstructible from retained metadata after payload GC.

## Reuse, cancellation and Canonical provenance

Only matching versions from an actually activated observation can be borrowed.
Acknowledged records retain their original objects even after payload cleanup.
Pending records can be borrowed only while their original authority still matches
and their owning capture has no cancellation intent. The journal flattens reuse
chains to their original units. Borrowing never fabricates an ACK; its outcome
continues to follow the original unit's receipt or explicit cancellation.

Canceled or superseded pending obligations require fresh source observation and
fresh object identities. A new Raw-only observation can use an existing genuine
Canonical activation, including after policy off/on, without preparing a new
Canonical target. Existing Event versions retain their original Raw reference,
including unavailable references from Raw-off capture. New Event versions receive
the current frame's object reference or explicit gap. Raw-off preparation rejects
complete source archive rows and never retains them for later upload.

Any interrupted preparation containing records or units must be abandoned before a
new owner opens a new source. Empty complete observations and complete sets of
reused records or gaps can seal with zero new Raw units. Their completion describes
their own obligations; pending borrowed records remain pending.

## Evidence and remaining scope

Public Host Interface tests use controlled native OpenCode SQLite and real private
journals. They cover masked frozen bytes, escaped and duplicate JSON keys, actual
receipt recovery, ACK/GC reuse, changed source versions, pending borrowed outcomes,
authority changes, Raw-off followed by fresh observations, explicit gaps and source
interruption. Point lookup shares the paged outcome and fences obsolete owners.

The authenticated HTTP/PostgreSQL contract additionally runs production Host
preparation in separate Node processes, activates native Canonical data, removes
the source, loses a successful Raw response, recovers receipts, reclaims payloads,
then prepares a changed fresh observation after policy off/on. This exercises the
real Raw metadata, digest, timestamp, authority and object-identity contract.

OpenCode remains private and unregistered. Runtime capability selection, bootstrap,
scheduling, bounded archive browsing, complete native mutation/Search acceptance,
platform and capacity defaults remain subsequent integration work. This change
publishes no package and deploys or migrates no instance.
