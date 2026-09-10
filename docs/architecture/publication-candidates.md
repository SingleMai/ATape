# Canonical publication candidate preparation and validation

These are the candidate preparation and bounded validation increments of
[ADR-0059](adr/0059-opencode-publication-and-recovery.md). The Module stores and
validates a candidate separately from ordinary Canonical data. It cannot
activate a target and is not wired into HTTP or the Server Composition Root yet.
The full [publication contract](opencode-capture-publication.md) remains the
acceptance baseline; OpenCode is not enabled by this increment.

## Interface and ownership

`postgres.NewPublicationStore(pool, limits)` constructs a concrete Module over
local-substitutable PostgreSQL. `publication` defines its input/output values and
typed candidate failures. SQL and transaction sequencing stay in the private
Implementation with sqlc-generated access. There is no per-table Repository Seam.
If this Module were removed, its callers would need to implement scoped identity,
mode selection, retries, deadlines, leases, quota serialization and cleanup.

| Operation | Guarantee |
| --- | --- |
| Reserve | Authorize current Project access and capture ownership; bind immutable Origin and publication mode; return a server-generated reservation with finite expiry. |
| Begin | Consume the reserved identity with immutable capture ID, base head and transform version; allocate one writer fence. An identical retry returns the original fence and never renews its lease. |
| Put | Accept one bounded numbered part with its verified SHA-256. A repeated identity must carry the same digest and byte count. No upload can replace a sealed part. |
| Seal | Verify the complete contiguous numbered set and manifest digest through metadata pages; retain its immutable manifest. Sealed means transport-complete, not semantically validated or visible. |
| Validate | Normalize at most one next part, bind its immutable source versions and membership, and atomically save fixed Canonical bytes with progress and quota accounting. Validated still means invisible. |
| Status | Reauthorize before returning attempt state and a bounded metadata page; never return uploaded bodies as a client recovery source. |
| Renew | Extend only a currently live, unchanged authority, bounded by the original reservation expiry. Expired or superseded attempts cannot regain authority. |
| Reject | Durably reject a known unactivated attempt. An unknown ID never becomes a terminal rejection receipt. |
| Reclaim | Remove a bounded batch of the caller's parts that can no longer activate; retain receipt metadata until reservation expiry. Expired empty reservation records can then be removed. |

Reservation loss can leave a bounded, expiring server record. There is no API to
recreate an absent reservation with a client-selected token. Once its record is
cleaned up, the old identity returns `unknown`, not successful Begin and not proof
that a future publication capability never activated it. Permanent source mode,
Origin and writer-fence bindings survive reservation cleanup.

An attempt becomes superseded when its fence or base differs from the current
source control row. The current increment initializes the base to no active head;
only the later activation implementation may advance that pointer. All future
activation and cleanup work must share the account/source locking protocol and
exclude successful activations from this unactivated-candidate cleanup path.

## Bounds and transaction semantics

The constructor requires explicit limits; these are supported configuration
ranges, not release defaults:

- Part bytes: 1 byte through 4 MiB; target bytes: at least one part through 1 GiB.
- Pending payload bytes per account: at least one target through 16 GiB.
- Parts per target: 1 through 4,096; live reservations per account: 1 through 128.
- Lease: 1 millisecond through 1 hour; reservation lifetime: at least one lease
  through 24 hours. Short durations enable expiry acceptance with real time;
  production values still require workload validation.
- Status pages: at most 100 metadata records; reclamation: at most 32 parts plus
  32 expired empty reservations. Each operation owns a 30-second context deadline.

Parts may arrive out of order. The manifest is SHA-256 over UTF-8 records in
ordinal order: `ordinal:byteCount:lowercasePartSHA256\n`, starting at ordinal zero.
It also binds total parts and bytes. Seal checks metadata in pages of 100, never
loads the complete target body, and rejects gaps, extra parts or changed digests.

## Bounded Canonical validation

Each part encodes `publication.CanonicalPart`: a `Batch` plus a target declaration
with profile `atape.publication-target.v1` and complete Event, Usage and Thread
counts. Every part repeats the complete bounded Session/Thread header. Validation
uses the same `ingestion.PrepareBatch` Interface as legacy ingestion for identity,
Raw reference scoping, topology, tools and usage. Thread order is normalized before
comparing headers; Session, topology, target counts and capture provenance must
remain consistent across parts. A target can contain at most 100 Threads and
500 Events plus 500 Usage records per part. Cross-part duplicate membership and
incomplete declared counts fail validation.

`Validate` advances one part per call: `sealed` → `validating` → `validated`.
Its transaction replaces the wire body with fixed `canonical.WriteBatch` JSON
at internal format version 1. It persists allocated Event receive timestamps and
ingest sequence values, so later activation must consume these fixed bytes without
rerunning conversion. The original wire digest and byte count remain immutable
receipts for Put replay and Seal. Status reports wire receipts and current retained
payload bytes separately. Normalization can expand a unit; both the normalized
part limit and the change in target/account retained bytes are enforced atomically.
Failed normalization preserves the original body, receipt and previous progress.

The membership index holds body-free coordinates into these normalized units,
including 64-bit Event ordering and Search descriptors that bind Event content,
Session title/harness and Thread path. It does not duplicate full target bodies.
The source-version ledger binds stable identity/ownership and semantic content
for each projection/revision pair. Provenance-only Event upgrades retain the
existing Canonical content boundary. This ledger survives candidate reclamation;
rejecting a candidate does not permit redefining an already validated source
version. Deterministic invalid input rolls back the current part and leaves the
candidate available for explicit rejection, without skipping it.

An account-scoped transaction lock serializes quota changes across independent
connections. A source lock shared with legacy ingestion enforces the write-mode
boundary. Authorization uses the existing Project and captured-Session lifecycle
policy, including receipt replay. New reservations cannot adopt a legacy Session,
and the legacy batch path cannot mutate a reserved publication source.

Put, Seal and Validate storage work is followed by an authority check inside the same
transaction; expiry before that check rolls back both content and accounting.
This is the operation's final authority check, not a promise that its lease will
remain valid while the response travels over the network. Begin and Renew also
check finite validity in their final write statements. Storage errors and context
cancellation roll back the operation; callers reconcile an uncertain response
through the original identity.

Reclamation uses indexed account/source/attempt access and never evicts live
content to make quota. PostgreSQL dead tuples, indexes and permanent source
bindings and version fingerprints are outside the logical pending-payload budget; this is not a physical
disk-size ceiling. Cleanup scheduling, metadata retention policy and long-running
pressure acceptance must be completed before enabling the full workflow.

## Evidence and remaining work

The public Module Interface is tested against real PostgreSQL 17 with ordinary
connections, retries and scoped principals. Tests cover restart of the client
pool, candidate invisibility, manifest gaps, changed identities, mode exclusivity,
independent-connection quota contention, superseded writers, explicit rejection,
expiry and cleanup, metadata paging, and revoked membership. A database delay
fault exercises lease expiry during Put and Seal and verifies atomic rollback.
Validation tests also cover pool restart between parts, complete counts, duplicate
membership, inconsistent headers/source scope, invalid topology, child tools and
usage, source-version conflicts after reclamation, provenance-only upgrades,
64-bit Event indices, normalization capacity rollback, original receipt replay,
normalized-byte reclamation, mid-validation lease expiry, writer fencing and
revoked membership. These tests do not establish HTTP lost-response recovery or
atomic activation.

Before release: atomically commit the selected head, activation receipt and durable Search work; integrate
head-aware reads, visible aggregates and Search descriptor eligibility; expose
and secure the HTTP Interface; connect Collector recovery and OpenCode projection;
then run the native-source and supported-platform acceptance in ADR-0059.
