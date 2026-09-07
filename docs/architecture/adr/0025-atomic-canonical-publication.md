# ADR-0025: Atomic Canonical Publication

- Status: Accepted design; Implementation pending
- Date: 2026-09-07

Current ingestion upserts cannot withdraw an omitted Event or revise Thread parentage across bounded pages without exposing a partial result. ATape will add a provider-neutral publication capability: stage a patch against an immutable base or an explicit replacement, validate the complete target, then atomically activate it using a server-issued head and writer fence. This preserves the last successful view during updates and hides first publication until Canonical is ready, without teaching the server source continuation, fork, or rewind semantics.

## Decision

- The Adapter owns native grouping, stable source keys, target membership and relations. The Host owns redaction, bounded delivery, a metadata-only recovery journal and independent Raw progress. The Canonical Module owns authorization, staged validation, idempotency and publication. No provider-specific merge or continuation Interface is introduced.
- Stable Session identity/lifecycle owns Raw; immutable head-scoped values own visible Session metadata, Thread topology, Event membership and counts. Patch omissions preserve members; explicit replacement omissions withdraw membership. Neither operation deletes Raw.
- Begin precedes capture, binds the immutable base, and leases a writer fence. Numbered parts and an explicit sealed manifest are idempotent; bounded validation precedes a short activation transaction containing pointer, receipt and durable Search work. A stale writer must recapture under a new attempt, never relabel its old payload. Unknown expired receipts do not imply non-activation.
- The new protocol allocates server heads instead of trusting source timestamps, numeric hashes or lost local revision counters. Activation replay returns its original receipt without restoring an old head. Retry identity has a finite freshness/retention contract that prevents expired Begin keys being resurrected after receipt cleanup.
- Readers and visible aggregates use one activated head. Subsequent pages/Thread reads carry that head and fail with an explicit refresh signal if it changed; this is not a public historical-snapshot feature. First-publication staging grants neither ordinary visibility nor Raw authority. Raw can remain pending after Canonical activation.
- Search remains asynchronous and separate. Current membership plus a Search descriptor gates query eligibility, suppressing withdrawn or outdated hits while preserving unchanged indexed Events. Activation emits work for metadata/path changes as well as Event changes; stale workers and incomplete outbox ranges cannot claim newer progress.
- Keep legacy incremental ingestion and its omission semantics. Both old and new write paths enforce one mode per stable Session; there is no implicit in-place migration or fallback. Existing Codex does not need to migrate merely because Claude requires the new capability.

## Alternatives and consequences

Visible per-batch mutations are simpler but expose partial branch replacement and invalid intermediate topology. A single unbounded snapshot violates capture limits. Host-owned counters require a recoverable revision ledger in every source integration; server conditional heads instead centralize this distributed concern.

Materializing target membership references before activation costs O(target membership) preparation I/O in the initial Implementation, even for small patches. This buys bounded ordinary reads without a growing overlay chain; unchanged bodies are shared and not retransmitted. Candidate quotas, lease/receipt cleanup, head reachability and resumable validation are required, not optional follow-ups. Metadata-only recovery cannot reproduce source bytes that disappear before acceptance; this decision does not add a local content spool or implicit retroactive re-redaction.

This amends ADR-0003 and ADR-0009 only for the explicit new capability, and the Search publication behavior of ADR-0005. ADR-0007 Raw ownership/retention and ADR-0011 source presence semantics remain intact. Implementation must preserve ADR-0016 authorization and ADR-0017 transport rules.

The selected Interface and storage design (retained as local research evidence), recovery contract (retained as local research evidence), and executable behavioral model (retained as local research evidence) record the handoff. Model tests do not substitute for production PostgreSQL concurrency, crash recovery, bounded-memory, source integration or Codex regression tests.
