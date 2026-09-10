# ADR-0069: Read-only source comparison before durable capture

- Status: Accepted implementation detail of ADR-0059
- Date: 2026-09-10

Repeatedly preparing an unchanged source allocates complete per-record capture
metadata even when publication is skipped. Sealed captures also cannot be abandoned
as unsealed work. Payload reclamation retains record/receipt metadata, so that
approach grows local storage with every scan.

## Interface and alternatives

`comparePublicationSource` returns whether Canonical changed and whether fresh Raw
work is required. It owns a disposable scoped source view, validates and masks it,
and compares exact identities, fingerprints, profiles and complete membership with
actual activated coverage. It writes no capture, version, unit or checkpoint and
performs no HTTP. The caller supplies explicit record/deadline limits and current
Raw authority/admission when Raw is enabled. Failures are typed.

Two alternatives were rejected: preparing then discarding requires a new safe
metadata-GC protocol across version/history/borrowed Raw references; trusting native
timestamps or file modification metadata cannot establish Canonical equality after
rewrites. This read-only preflight adds a source pass only after coverage exists,
but avoids persistent per-poll membership. With no activated baseline it returns
changed without opening the full source.

The Interface belongs to the Host application Module, not Presentation or the
provider Adapter. Its existing source and journal Seams represent real external
packages and local storage. Internal projection helpers are shared with formal
preparation rather than adding a replaceable service for tests. Their Depth keeps
masking, identity, exact membership and coverage semantics out of the scheduler.

## Invariants and bounds

A preflight is not a publication capture or proof. It closes before Begin and no
page is reused for formal preparation. Changed Canonical requires a fresh full
source capture after Begin. A Raw-only change uses a fresh observation under an
existing genuine activation, preserving old Event references and Canonical head.
Missing source files fail; they never imply deletion of ATape history.

Canonical compares complete masked Session, Thread, final wire Event and Usage
fingerprints, excluding Host revisions and immutable Raw references. Abandoned
observations can consume revisions and do not establish published equality.
`canonicalSourceProjection` supplies the exact same validation, ordering and hash
semantics to preparation and comparison; the projection profile is unchanged.

Exact membership uses a Set of SHA-256 identities, capped by explicit record
admission (at most one million). This retains fixed-size identity metadata rather
than source payloads. Frame visits have the same explicit cap, including Raw-off
frames without Canonical output. Pages and frames retain the source Interface's
bounds. One operation deadline (at most five minutes) includes acquisition and
comparison, and Scope release runs on error/cancellation. Logical limits do not
claim a measured physical RSS bound or hard wall-clock preemption of synchronous
provider work. Release defaults await platform/capacity acceptance.

The owner serializes recovery, comparison and fresh capture; unresolved captures
must be reconciled first. Every journal read is fenced. Before an unchanged result,
comparison checks actual Canonical and observed Raw coverage still match its
baseline, rejecting concurrent replacement rather than accepting a stale no-op.

## Independent Raw outcomes

Raw-off views cannot return full Raw content. Raw-on comparison shares the exact
recursive redaction/JSON-TEXT handling and fingerprint semantics with preparation.
It checks actual activated complete Raw membership. Actual ACKs remain reusable
after payload reclamation and authority changes. Pending rows require their
original owning capture to have no cancellation intent and the same current Raw
authority; canceled rows require fresh work. No comparison creates an ACK.

The optional local Raw record manifest `admission` hashes the four explicit
packing limits and actual empty-object/wire-envelope byte widths. The latter are
computed by the same metadata builder as preparation; timestamp values themselves
do not enter the hash, so the passing clock does not create a new observation. Matching content plus the same admission preserves explicit
capacity gaps without allocating a fresh failed observation each scan. Changed
admission or old manifests without this field request one fresh Raw observation.
Receipt progress alone does not retry an unchanged historical gap; a complete
observation records that explicit outcome until content, profile or admission
changes. This is local metadata, not a wire or semantic projection version change. Old
seals remain readable; replay checks include the optional value. No SQLite format
migration or rewrite of historical references is needed.

## Verification and remaining work

Public Interface tests use native OpenCode fixtures and actual SQLite journals.
They cover repeated unchanged scans without record growth or HTTP, abandoned
versions, Canonical and Raw-only edits, pending/canceled/ACK outcomes, Raw-off/on,
capacity admission, duplicate membership, deadline closure and bounded records.
Existing preparation/recovery tests exercise the shared projection refactor.

Collector scheduling/attribution, bounded Raw browsing, native end-to-end Search
and policy acceptance, long-term metadata retention and physical capacity remain
required before OpenCode is registered or enabled. This increment publishes no
package and deploys no instance.
