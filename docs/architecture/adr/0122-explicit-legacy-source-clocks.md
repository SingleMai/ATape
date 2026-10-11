# ADR-0122: Explicit nullable source clocks in legacy collection

- Status: Accepted
- Date: 2026-10-11

## Context and alternatives

Codex legacy collection currently substitutes an epoch for missing or invalid
Event clocks, uses file modification time for Session recency and a derived spawn
clock, and orders some records by their clock. These values cannot establish
source occurrence time. Adding record-span analysis would magnify those invented
facts. Missing clocks must not discard an otherwise supported record, change its
native order, or become an upload/observation timestamp.

[ADR-0114](0114-explicit-unknown-conversation-time.md) admits explicit null clocks
in Canonical v3, but does not implicitly enable that profile in legacy collection.
Codex still has a legacy runtime, bounded cursor and independent Raw receipts.

| Interface design | Depth, Leverage and Locality | Decision |
| --- | --- | --- |
| Explicit static legacy Canonical v3 admission | Reuses the existing Collector and transport Interfaces. Profile admission and validation remain inside their owning Implementations; Codex hides clock extraction and ordering. Keeps its cursor, Raw progress and retry workflow local. | Selected for this increment. |
| Move Codex to sourceCapture v2 | Gains complete-target publication and frozen source recovery, but also changes discovery, opening, target counts, legacy adoption, Raw migration and checkpoint recovery. | A separate future increment; not required to correct source clocks. |

## Admission and compatibility

An Adapter manifest may explicitly declare `legacyCanonicalProfile` as
`atape.acp-centered.v3`. It cannot combine that declaration with sourceCapture.
Absent the declaration, legacy collection retains Canonical v2 and its existing
validation, payloads and request behavior. Nullable values never select a profile.

The Host gives an admitted factory a `legacyCanonicalProfiles` support fact. The
new Codex factory checks that fact before source access and returns the same
explicit runtime profile. The Host rejects a manifest/runtime mismatch. An old
Host cannot gain support merely by ignoring an unfamiliar manifest field.

Codex defers opening its archive until its first collection request. The deep
Collector Module affirms Server support before collection or checkpoint writes.
The CLI-authenticated `GET /api/v1/ingestion/canonical/capabilities` affirms modern
Canonical profiles independently of Publication. Its
`atape.canonical-capabilities.v1` representation lists modern v2/v3/v4 support;
historical v1 remains a write-compatibility path, not a discovery target. Only an
explicitly absent or unimplemented endpoint permits fallback to the existing
affirmative publication-target-v3 capability on older Servers. An invalid or
negative capability, authentication failure or transient error is not support.
The transport binds the selected profile into validation, projection and batch
identity. It never downgrades a nullable observation to v2. Managed candidate
admission checks the same prerequisites before maintenance or Collector pause.
The remote Server is an existing real Seam, not a new mock-only Interface.

Legacy checkpoints and Raw receipts retain their format. This path does not use
the sourceCapture frozen journal and does not claim its source-free recovery.
Source-dependent legacy retry and redaction-policy uncertainty retain their
existing limits. Tests must use genuine historical Host implementation or bytes
for old-Host refusal; a current Host with an old version label is not evidence.

## Source facts and ordering

Codex preserves supported records with missing, null or invalid source clocks,
using explicit null rather than an epoch. Known values must satisfy the source
timestamp/storage contract. Usage retains its separate required-clock contract.
File modification time still supports discovery, source generation and revision;
it does not supply Session or Event occurrence time. Legacy observation and Raw
capture metadata retain the stable selected-file modification basis so replaying
an unacknowledged chunk reconstructs the same receipt metadata. They do not fill
missing source clocks or claim the time of a later collection attempt.

Session recency is the maximum admitted source clock in the selected frozen
snapshot, including actual metadata/title updates and captured source records,
or null when no source clock exists. Continuation and Raw pages keep the same
frozen value at a Session revision. A derived child-spawn record carries only an
available native child metadata clock, or null; it is marked derived.

Physical byte offsets determine file-local native record order. A bounded,
persisted per-Session source-object/generation registry assigns disjoint numeric namespaces above
the historical timestamp coordinate range. Deleted sources retain their ranks;
new sources never reuse them. Each source record has its own coordinate, and
append or metadata-driven discovery reordering cannot change an existing one.
Missing or reversed clocks do not move a record to the beginning or deduplicate
it away. Ordering multiple files in one Thread is derived and disclosed as such.
Item-update ownership remains a separate projection concern, not an accidental
comparison of the new ordering coordinates.

Advance the Codex projection revision so a supported old cursor replays corrected
Canonical facts once with stable Event IDs and higher revisions. Retain saved Raw
offsets and acknowledgements. Do not rewrite previously accepted Canonical,
publication or Raw bytes in the Server by guessing that every epoch is invalid.
Unavailable source history remains unrepaired and must be disclosed by guides
and subsequent record-time analysis.

## Validation and ownership

Callers use the same Adapter collection, Host loading, Collector and transport
Interfaces as production. Verify missing/null/invalid clocks in supported source
formats, physical source order, all-unknown and mixed Session clocks, derived
spawns, page/retry consistency, one replay of old active/completed cursors and
unchanged Raw progress. Unsupported old Host/Server paths must fail before source
collection or progress mutation; default v2 behavior must remain unchanged.

The current behavior and remaining limits belong to
[Codex](../../adapters/codex.md) and [Session Analytics](../../session-analytics.md).
This decision adds no Server migration, package-publication authorization or
deployment claim.
