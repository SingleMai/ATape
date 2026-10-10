# ADR-0113: Explicit unknown conversation time

- Status: Accepted
- Date: 2026-10-10

## Context and alternatives

The bounded Cursor reader has message order but no trustworthy per-event clock
or Session update clock. The shared Interface currently requires those clocks.
Filesystem modification time, upload observation time and repaired metadata
cannot supply the missing source facts. A fabricated epoch also makes unknown
history look dated and makes Search and Overview disagree about its meaning.

One design leaves all missing-clock sources unavailable. This preserves the old
Interface but prevents faithful capture of otherwise useful conversations.
Another adds a second timestamp-kind field beside a required string. This admits
contradictory combinations and spreads placeholder handling through every caller.
The selected design makes source clocks nullable in an explicitly negotiated
profile while keeping observation clocks independent and required.

## Interface and compatibility

`atape.acp-centered.v3` permits explicit JSON `null` for Session `updatedAt` and
Event `occurredAt`. A known value remains a valid RFC 3339 timestamp. Missing
fields, empty strings and invalid clocks are errors. New writes reject a timestamp
that becomes Go's zero time at PostgreSQL's microsecond storage precision, in
every profile. This includes the zero instant and its first 999 nanoseconds;
otherwise a known source clock could return from storage as unknown. The first
microsecond remains a known value. Other legacy sentinel values, including the
epoch, are not rewritten. Usage clocks
remain required: this increment neither invents Usage nor changes its independent
measurement contract. `observedAt`, server receipt times and reader/index
watermarks keep their existing meanings and cannot become source occurrence times.

The v1/v2 profiles retain their existing clock requirements. The default Host
profile remains v2. A source-capture header may explicitly select v3; the Host
validates that selection before preparation and freezes it in source metadata.
Legacy collection cannot implicitly opt into v3. Existing providers retain their
projection hashes and write behavior when they do not select the new profile.

Publication target `atape.publication-target.v3` requires canonical v3 and the
complete-target/retained-Thread rules of target v2. It is advertised in the
existing capability list. A Server without that capability fails before content
preparation/upload. Every part of a candidate carries the same target and
canonical profiles, including a part containing only known clocks. The existing
header digest binds those choices; selection never depends on individual parts.
Targets v1/v2 do not admit canonical v3. Frozen bytes and journal receipts remain
the recovery authority; no new journal store or clock-derived checkpoint exists.

Go may retain known-string transport construction with private explicit-null
flags and strict JSON codecs. Its Canonical records use a zero `time.Time` only
as an internal unknown representation. Wire and normalized publication JSON use
`null`, never a zero-date string. PostgreSQL source-clock columns are nullable.
The migration normalizes previously stored exact zero source clocks to SQL NULL,
including Search and Overview facts, so old zero rows page in the unknown group.
Frozen publication bodies, manifests and digests remain byte-identical; their
zero clocks already decode to the same internal unknown marker. Observation,
receipt and Usage columns remain non-null. This is a new schema
requirement, not permission to deploy or run a production migration.

## Read-model behavior

The Reader exposes nullable source clocks and shows “Time unknown” rather than a
date or observation clock. Native Event order remains source order/Event index;
Session lists put known update clocks first and use stable identity/order for
unknown clocks. A Session with unknown update recency cannot become active merely
because it was just uploaded. Explicit provider lifecycle remains independent.

Search continues indexing unknown-time messages. Within a Project it orders known
occurrence clocks descending, then unknown clocks, with descending Event ID as
the tie-breaker. Keyset continuation crosses the known/unknown boundary exactly
once and pages within unknown rows by identity. Old valid known-time cursors can
remain readable; old offset cursors remain invalid. Search never substitutes
observation time in its ordering key.

Overview excludes unknown source clocks from dated activity and usage metrics.
Its unknown-time disclosure retains existing legacy sentinel handling and also
counts explicit null message clocks, deduplicated by Session. Native records,
covered publication facts, JSON fallback and administrative backfill must agree.
Canonical storage, Raw archives and Search remain separate concerns.

## Module boundaries and validation

The existing ingestion, publication, conversation, Search and Overview Modules
own their respective validation, persistence and projection behavior. Their
Interfaces gain one honest missing-fact representation; no pass-through Module or
mock-only Seam is added. The independently installed provider and HTTP deployment
boundaries remain real Seams. This preserves Depth and gives future providers
Leverage without distributing placeholder rules; changes stay local to each
owning Implementation.

Tests use the callers' Interfaces: Schema/Host preparation, authenticated HTTP,
real PostgreSQL, Reader presentation and Search continuation. They must cover
explicit null versus missing/invalid input, v1/v2 rejection, mixed-clock parts,
capability mismatch, replay and head replacement, nullable persistence and dated
statistics. Current behavior and remaining acceptance belong to the ingestion,
conversation, Search, Overview and Cursor feature guides.

Cursor factory/collection, stable source identity and trustworthy creation
attribution are subsequent increments. Synthetic fixtures remain compatibility
evidence; native Cursor CLI/IDE acceptance is still deferred.
