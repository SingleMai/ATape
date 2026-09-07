# ADR-0026: Bounded Raw Byte Streams

- Status: Accepted design; Implementation pending
- Date: 2026-09-07

Whole-record string segments cannot retain arbitrarily large transcript records, no-newline outputs or non-text artifacts while applying safe cross-segment masking with bounded memory. ATape will add an explicit byte-framed Adapter capability and a Host-owned, versioned streaming masker. This preserves original bytes outside declared masking spans without adding a local payload spool or treating a transport/read-frame boundary as a redaction boundary.

## Decision

- Keep provider attribution and source-coherence/framing in the Adapter; keep masking, bounded delivery, cancellation and progress inside the Collector. Canonical, Raw and Search remain separate. The Raw server already supports arbitrary decoded bytes; provider packages must not Base64-encode around the Host's masking step.
- Distinguish eligible source prefix, bounded byte frame, safe redaction frontier and post-redaction transport chunk. A large complete JSONL record may span many frames; incomplete live tails remain pending. Invalid UTF-8 remains bytes rather than being replacement-decoded into allegedly lossless text.
- Version new Raw masking semantics instead of claiming exact compatibility with the legacy whole-string regex cascade. Match configured byte literals and recognizable credential families over the original stream, including overlapping and cross-frame matches. Mask their union. Recognized unterminated secret bodies and unresolved candidates at a closed captured boundary are handled conservatively; temporary EOF never flushes them as plaintext.
- Bound policy size, compiled state, syntax lookahead and output expansion. Confirmed token/private-key body length does not require holding that whole body in memory. Unresolvable capacity/source errors stop the affected obligation without silently reporting complete capture.
- Raw masking does not promise to decode secrets from arbitrary JSON escapes, Base64, compressed/encrypted data, image pixels or audio. Binary passes through the same declared byte policy, not a bypass. Retained evidence is faithful subject to that transform; redacted artifacts are not promised to remain parseable/executable. The byte view/download must not silently substitute invalid UTF-8 or execute captured active content.
- Freeze source boundary, transform/provenance and packing metadata for every delivery unit. Data chunks are at most 256 KiB and always nonfinal; a closed generation is sealed by a distinct empty final chunk after data acknowledgement. Nonfinal zero-output units send no chunk but still require an atomic metadata checkpoint tied to prior acknowledged output.
- Persist only bounded metadata and validated scanner/replay state; never plaintext carry or source bodies. Re-read and verify withheld bytes on restart. Changed/missing source or incompatible policy cannot be recovered by pretending a digest is content. Transformation identity is immutable within a generation; distributed generation reconciliation remains a separate Collector consistency responsibility.
- Existing Codex/string-segment callers keep their current contract until a separately tested migration. New byte capture requires explicit Host capability and transform-provenance metadata support; it must not fall back to independent per-frame string redaction.

## Trade-off

Larger whole-record buffers only move the size ceiling and do not solve cross-record masking. A snapshot/two-pass approach can retain legacy decisions but requires source immutability or a protected spool with additional disk/privacy policy. Versioned conservative streaming semantics instead keep memory bounded and respect the accepted metadata-only local progress boundary, at the cost of declared false positives and changed redacted bytes. This amends ADR-0009 for the new capability; ADR-0007 chunk/Raw retention semantics and ADR-0025 Canonical-first ownership remain intact.

The framing design (retained as local research evidence) fixes Interface details, bounds and guarantee limits. The 24 primitive/packing tests (retained as local research evidence) validate the design model, not the full production credential grammar, file mutation, HTTP recovery, restart journal or heap-capacity guarantees. Those are mandatory downstream implementation and release tests.
