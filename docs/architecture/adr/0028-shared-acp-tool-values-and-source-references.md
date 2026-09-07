# ADR-0028: Shared ACP Tool Values and Versioned Source References

- Status: Accepted design; Implementation pending
- Date: 2026-09-07

The user approved filling ATape's common tool representation while adding Claude capture. Existing Adapter ACP tool updates are flattened to title/status and lose correlation, arguments and results. Select a versioned ACP-centered profile retaining the bounded, validated and redacted update end-to-end, with one common reader/rendering projection rather than provider-specific Canonical blobs or an independent tool store.

Call and result remain distinct Events sharing a scoped tool correlation ID. ACP input/output/content fields preserve JSON value presence; common derived display/Search text is not a second writable authority. The Host masks admitted fields before canonical encoding, with explicit partial omissions for unsupported/oversized values. The new wire profile defines fractional-number serialization and requires cross-language vectors; legacy v1 behavior does not silently change.

Canonical Raw references identify an exact generation through a durable opaque Host token, which may be pending until Canonical-first Raw allocation binds it. Event links never fall back to a newer generation or pretend source offsets are redacted archive offsets. Appends may grow that generation; this is not a per-Event filesystem snapshot. Raw bytes remain outside ordinary Canonical/Search reads.

This amends ADR-0009's flat HTTP projection for the new profile and extends ADR-0007/0027's generic metadata binding. It preserves ADR-0023 topology and ADR-0025 atomic publication. The selected mapping contract (retained as local research evidence) fixes source roles, conservative graph selection, finite bounds, shared Interfaces and validation gates. Rich-media execution/fetch/playback and a separate Claude UI are not included; native fixture/model evidence is not production support.
