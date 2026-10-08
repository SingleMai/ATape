# ADR-0095: Claude planned Read-pair results in reverse order

- Status: Accepted scope; implementation and acceptance are recorded in the feature guide
- Date: 2026-10-09

## Context

[ADR-0090](0090-claude-read-pair-result-parents.md) proves two successful root
Read results in call order. The isolated native dual case recorded alongside
[ADR-0094](0094-claude-repeated-single-read-auto-file.md) instead completes
`text@0, Read@1, Read@2` as C0/C1/R1/R0. Each result names its own call in its
parent, source assistant UUID, tool ID and literal file receipt. Its first
automatic round copies U/G/P/C0/C1/R1/R0/A in that same physical order, then
adds B/S and a real answer pair. No second dual round was invoked.

The prior Implementation accepts R1 through ordinary linear chaining, without
a pending pair, then stops at R0. Actual previous-main opaque ACKs therefore
include a committed R1 with no readPair state. Supporting only fresh capture
would leave these acknowledged conversations stuck.

## Decision

Keep the Claude Adapter Module's collect Interface, projection 4, legacy capture,
Event/usage/Raw identities and existing cursor fields. The Implementation hides
the selected reverse graph and its recovery; no Host/Server Seam or migration
is added. Canonical, Raw and Search retain separate ownership.

Select only the native planned root layout. Prove the adjacent P/C0/C1 from the
same authenticated committed-prefix bytes: root identity/version/flags, one
text@0, successful Read calls at indices 1/2, shared response ID/model,
tool_use, distinct committed call UUID/tool IDs and exact parents. A global
known-call lookup may classify a candidate but cannot authorize it. Existing
ordered planned/tool-only profiles and ordinary single/mixed-tool behavior
retain their scope.

Validate R1 against C1's parent/source/tool/path and successful receipt shape.
Before acknowledging it, prove the proposed P/C0/C1/R1 committed prefix is
resumable. Save the existing private v1 readPair fields with secondCall* naming
the remaining C0 result, rather than assuming physical result order equals
call order. End its page. The next complete record must be R0 matching C0 and
R1's prompt. Commit its ordinary tool update once, then clear pending state
and restore ordinary chaining. Partial/absent R0 remains pending without busy
retry; a conflicting complete record preserves the input ACK.

Recognize the C0/C1/R1 suffix of an actual older cursor without pending state,
and prove its exact committed P/C0/C1/R1 source before adopting its remaining
C0 requirement. Re-prove recognized reverse pending state against that source
on restart, including EOF. Verify the stored result/call/tool/path/prompt and
seen suffix. Zero-byte adoption must not replay acknowledged Events or usage;
malformed recognized state fails without cursor reset. This is source/cursor
consistency, not cryptographic cursor authentication.

Reverse recovery decodes at most four selected LF frames in the existing
256 KiB proof tail. Each selected frame, including its first R1 receipt, fits
64 KiB including LF. This is the new reverse profile's policy, not a native
receipt limit. The remaining R0 retains ordinary 16 MiB receipt parsing and
per-record requested budgets. Ordered receipt policies and the larger manual
profile are unchanged. Prospective ACK proof must retain all selected history;
prefix hashing remains O(committed prefix) and is not an atomic snapshot.

Allow the first-slug automatic eight-record turn to bind receipts to its two
current calls in either proved order, with each call used exactly once. Its
copies preserve the actual original sequence and complete decoded values;
retained P-through-A metadata uses that same sequence. Existing 64 KiB selected
frame, 512 KiB original-tail and 640 KiB group limits, atomic Raw-only admission
and pending real-answer rules remain unchanged. Existing-slug Read2 replay and
manual reverse-result reinjection are not selected by this decision.

## Alternatives and verification

Permitting any result parent found in the call map admits stale branches and
has less Locality than a current adjacent response proof. Sorting results by
call index changes source order and old Event identity. An atomic two-result
group couples independent budgets and cannot preserve the already acknowledged
R1. New cursor fields or a reset add a compatibility protocol without Leverage;
the existing remaining-call fields provide the required Depth.

Verify native literal cuts through collect, fresh runtimes and exact retries:
both call/result boundaries, pending EOF/partial/intervening records, complete
copy equality, Raw off/backfill/advanced receipts, fresh/remaining capacity,
selected frame bounds, bad cursor/source metadata and source repair. Resume
actual previous-main opaque checkpoints, especially the already published R1
and genuine Event-only call checkpoints. Installed tarballs and authenticated
HTTP/PostgreSQL must retain old Reader Events, both own-call anchors in native
result order, latest API usage, message-only Search, complete Raw and deletion
retention. Record actual checks and source limits in the owning Claude guide.

This increment does not establish tool-only reverse completion, more/error/async/
interleaved calls, repeated Read2 compaction, more reinjected files, children or
Active Path adoption. Publication and manual Server deployment remain separate.
