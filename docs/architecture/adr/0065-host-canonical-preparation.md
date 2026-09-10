# ADR-0065: Host Canonical publication preparation

- Status: Accepted implementation detail of ADR-0059
- Date: 2026-09-10

The OpenCode Adapter now supplies complete target counts and bounded pre-revision
drafts. The Host must turn these into final bytes before delivery, without moving
masking, revision allocation or recovery into the provider Adapter.

## Interface and ownership

`preparePublicationCanonical` accepts a tracked Raw-off capture, explicit
observation metadata and a lazy scoped source Effect. The source is a real varying
Adapter at the local-history Seam; the application Module has no OpenCode or Node
SQLite dependency. Effect carries the source's failures, requirements and lifetime.

Begin and attribution happen before this operation. It verifies the journal's
persisted binding/Begin and the fresh source Origin. It refuses a preparing capture
that already has Canonical units or Session records, so failed preparation cannot
be completed from a new snapshot. Callers own one preparation per claimed owner;
another process must claim a new owner, fencing the previous process. A failure
retains an unsealed capture for explicit abandonment and reclamation through the
existing recovery Interface. It never advances coverage or sends a prefix.

Within its source scope, the Host validates and masks bounded Canonical slices,
allocates source record revisions, projects ACP through the existing common wire
mapping, packs complete parts and binds records to those parts. Only final encoded
bytes enter the journal. Source scope exit occurs before the local publication
seal's control-only status request. Subsequent delivery has no source dependency.

The alternative of having each Adapter encode final publication requests would
duplicate masking and protocol policy and expose remote authority to provider
code. Preparing an entire target in memory would lose the source Interface's
bounds. The selected application Module hides this orchestration while reusing the
real journal and publication Seams. The existing Node transport now calls the same
ACP projection function; its legacy batch IDs and behavior remain unchanged.

## Versions and byte admission

Session/Thread headers are masked and versioned once, then repeated identically
in each part. The target counts always describe the full replacement. Event
fingerprints cover the final Canonical semantics, including author derived from
the Session actor. Fingerprints exclude observed time, allocated counters and Raw
provenance; existing Event versions retain the journal's original Raw reference.
Event and usage ledger keys hash the native Thread/record pair, so two Threads
may legitimately reuse a provider-local ID. Host/transform/source profiles are
included in revision allocation. Batch IDs have fixed bounded identities.

The source supplies at most 100 frames per page, makes progress on nonterminal
pages and provides sequential Event indices with strictly increasing source order.
Each frame passes the shared 500-Event/usage, content, tool and topology checks.
Packing checks actual encoded part bytes and negotiated part/count/target budgets.
An empty complete target still produces one header part. Unknown counts, duplicate
membership, missing Events, wrong Origin, oversized records and Raw content under
Raw-off fail without sealing.

Transport bytes alone are insufficient: Server validation replaces the wire body
with a normalized Canonical body containing source keys, derived identities,
digests and receipt provenance. Both forms use the same negotiated part and target
budgets. `canonicalMaterializationBound` reserves a conservative upper bound for
the existing publication-target.v1 layout: Go-compatible JSON escaping of the
batch, 4 KiB fixed header headroom, each record's repeated encoded source scope,
two additional scope copies, and 2 KiB per Thread/Event/usage record. The fixed
record headroom covers field names, bounded derived IDs/digests, repeated Adapter
metadata and maximum-width timestamps/counters. Header fallbacks fit the fixed
headroom. HTML and U+2028/U+2029 escaping is counted rather than guessed as an
ASCII expansion ratio. Both per-part and aggregate materialized bounds must fit.

This bound intentionally leaves capacity unused and is not a release default.
Changing the Server's normalized record layout must preserve or revise this
versioned admission contract. Cross-language tests execute the production Host
against controlled native SQLite, then run every actual frozen batch through
`ingestion.PrepareBatch`, add maximum-width validation provenance and compare its
Go JSON size to the Host bound. Additional cases exercise maximum scope/header
metadata and JSON escaping. This avoids relying on a fake validator for the
capacity boundary.

## Verification and scope

Real SQLite source/journal tests cover masking before persistence, fixed headers,
multiple parts, unchanged/changed versions, derived-author changes, same IDs across
Threads, lost PUT responses after source deletion, scope closure, malformed or
oversized/incomplete targets, wrong Origin and interruption followed by a fresh
owner. The remote test Adapter implements the existing publication Seam; actual
HTTP/auth/PostgreSQL behavior remains covered by its separate integration contract.
The new cross-language tests additionally exercise real Server normalization.

This increment handles explicit Raw-off preparation only. It rejects Raw-enabled
Begin before opening the source, including forced capture policy. Raw packing,
independent observations and receipt-aware reuse require their own preparation
operation next. No installed Adapter capability or scheduler selects this Module
yet, and no OpenCode package publication, deployment or migration is performed.
