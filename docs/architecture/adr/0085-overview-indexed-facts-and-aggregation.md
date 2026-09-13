# ADR-0085: Indexed Overview facts before database aggregation

- Status: Accepted design; indexed-facts increment implemented locally
- Date: 2026-09-13

## Context

The current Overview optimizations narrow facts, defer previews and avoid chart
aggregation on Session-page requests. They still expand selected publication JSON
for Events, Usage, model choices and unknown-time disclosure. Go still receives
bounded facts for both periods and builds all matching Session rows before paging.
The all-time Session directory and option payload impose separate limits.

Publication validation already prepares one bounded, normalized Canonical part
per transaction. Activation selects a complete candidate by changing its current
head together with metadata and its receipt; it must not scan the complete target.
Native Canonical Events and Usage already have relational representations.

The [feature guide](../../team-overview.md) owns metric semantics and current
verification. Indexed facts and bounded backfill are implemented locally; database
aggregation remains subsequent work. No production migration or deployment is
established by this decision.

## Alternatives

| Design | Benefit | Cost and suitability |
| --- | --- | --- |
| Cache complete dashboard responses | Cheap repeated reads | Cold reads retain the current cost; invalidation spans publication, deletion, membership and all filter combinations. It also introduces a freshness contract. |
| Asynchronously maintain daily totals | Small aggregate reads | Head replacement, corrections, distinct Sessions/messages and missing token classifications require reversible contributions. Publication and statistics can become temporarily inconsistent. |
| Prepare indexed facts with Canonical publication, then aggregate on read | Avoid repeated body parsing while preserving current-head visibility | Adds derived storage and bounded write work; requires backfill and differential verification before replacing Go aggregation. |

Choose the third design. First remove body parsing from statistics without
changing aggregation. Then move aggregation and page selection into PostgreSQL.
Daily summaries and caching remain possible later, justified by measured cost.

## Ownership and Interface

The Team Overview Module continues to own normalized queries, period boundaries,
metric semantics and result formatting. The PostgreSQL Adapter owns storage,
authorization queries, execution plans and the consistent read transaction. The
existing publication validation path prepares derived facts in that Adapter.
HTTP presentation only translates requests and results. This adds no remote
deployment unit, statistics queue or per-table Repository Interface.

There are two materially different persistence Interface choices:

1. Keep the current raw-fact snapshot and preview-selection callback indefinitely.
   This preserves Locality for pure Go calculations, but makes allocation and
   transfer proportional to matching fact count and prevents database paging.
2. Replace it, in the aggregation increment, with one consumer-owned operation
   accepting a normalized Overview query and returning an aggregate snapshot,
   page metadata and authorized preview excerpts. PostgreSQL hides aggregation,
   page selection and excerpt retrieval in one transaction; the memory Adapter
   implements the same observable contract.

Use the existing Interface for the facts increment and option 2 for aggregation.
This increases Depth and Leverage at the existing persistence Seam: callers do
not orchestrate separate count, list and preview calls. Keep the new port and
result types with the consuming Overview Module, avoiding a dependency from
Canonical domain types onto dashboard responses. Replace the old callback when
its callers migrate; do not retain two permanent query stacks. SQL and memory
implementations share contract fixtures to keep metric semantics in one place.

## Facts and visibility

Prepare two narrow fact relations from each normalized part:

- Message facts: attempt/part identity, Event identity and entry index, Session
  and Thread identity, occurrence time, author, root-Thread flag, source order
  and Event index. Preserve child messages for activity and unknown-time counts.
- Usage facts: attempt/part identity, canonical usage identity, Session and
  Thread identity, occurrence time, raw model and nullable token classifications.

No message body, Raw payload or Search document belongs in these relations.
Root classification is derived from the validated topology. Membership continues
to locate exact source entries for the bounded page previews. Legacy writes keep
using native Event/Usage rows; reads union the two mutually exclusive visibility
paths rather than copying legacy data into a second store.

Facts reference retained candidate parts, with cascading reclamation. Session
identity is derived through the attempt/source binding rather than duplicated
on each physical row; membership retains the source entry coordinates.
They must not require a foreign key to an active Session: first publication
creates that Session only during activation. Fact identity is scoped to an
attempt so immutable versions of one Event can coexist without conflicts.

Start index evaluation with attempt plus occurrence time on both relations and
attempt plus model/time for Usage. Verify the actual selected-head and filtered
plans before adding covering columns or additional indexes. Row width, index
size and validation write amplification are acceptance evidence, not free costs.

Validation writes facts and an explicit per-part projection-version marker in
the same transaction as its existing cursor advancement. A complete empty part
has a marker even though it has no fact rows. Projection version is separate
from the Canonical format and immutable upload receipt/digest.

Overview joins facts to the source's selected current head within its existing
repeatable-read transaction. Preparing a candidate exposes nothing; changing the
head exposes its facts atomically. Activation performs no per-fact rebuild or
deletion. Old-head facts become invisible and follow bounded part reclamation.
Every request still checks current membership and retained Session/Project state.

## Migration and rollback

Use additive schema and retain readable normalized Canonical bodies. New
validation writes the new projection; a resumable, rate-limited backfill prepares
one retained normalized part at a time using the same projection logic. Backfill
does not read Raw, rerun a provider converter, alter receipts, or advance the
publication validation cursor. The implemented backfill locks only one part with
`FOR UPDATE SKIP LOCKED`; it acquires no subsequent account, source or attempt
lock and therefore cannot invert validation/reclamation lock order.

During transition, select indexed facts for a part only when its expected-version
marker is complete; otherwise decode that part through the existing JSON path.
The branches must be mutually exclusive in the same read snapshot, including
when a part contains zero messages or zero Usage. This permits old validated
candidates to activate and old binaries to run during rollout without missing
statistics or double counting. A failed backfill rolls back facts and marker
together and can retry idempotently.

Prefer this per-part fallback over a Team-wide switch: one old candidate should
not force every already-prepared part back through JSON. Measure fallback parts
and coverage explicitly. Retire fallback only after all retained parts that can
become readable are covered and every writer guarantees preparation; current-head
coverage alone is insufficient. Reverting to an older writer reopens the fallback
requirement, so fallback removal is a separate compatibility decision.

Derived rows and indexes increase physical storage and WAL. Existing logical
pending-payload accounting does not bound those bytes. Measure amplification and
validation/reclamation latency, rate-limit backfill, and retain per-part record
bounds; do not change the meaning of existing byte proofs to hide this cost.

## Backfill operation ownership

Use an explicit operator command rather than an automatically started worker.
A worker would need startup configuration, competing-instance pacing and a
permanent lifetime owner for a transitional migration task. The command owns
bounded sequential execution, pacing, SIGINT/SIGTERM cancellation and progress
output. The Adapter exposes coverage and one-part backfill operations using the
operator's database credential; these are not new public HTTP capabilities.

The per-part marker is the resumable checkpoint. No unlocked work does not prove
coverage: another worker may hold an incomplete part. Report retained/current-head
missing counts separately. Command bounds and rollout instructions live in the
[feature guide](../../team-overview.md#indexed-publication-facts-and-operations).

## Aggregate and page reads

The second increment keeps the external API and one authorized read snapshot.
PostgreSQL returns summary/dimension aggregates and only the requested Session
page. Read preview bodies after selecting that page in the same transaction.

- Aggregate message and Usage inputs separately before joining per-Session
  results; joining raw messages to raw Usage would multiply counts and Tokens.
- Evaluate model eligibility separately in each period. Matching model Usage
  admits that period's Session messages; Tokens include only matching calls.
- Count root user inputs by distinct Session/source-order identity, not Event
  rows. Child activity can activate a Session without adding root user inputs.
- Preserve missing token classifications, partial coverage, safe-integer limits
  and overflow errors. SQL sums need accompanying presence/coverage information;
  `COALESCE(SUM(...), 0)` alone is not the metric contract.
- Compute period-level distinct counts from eligible identities. Summing daily
  distinct counts is invalid when identities occur in more than one bucket.
- Preserve source-time boundaries, Team timezone, deterministic Session ordering
  and exact preview source-order/Event-index/identity tie-breaks.
- Keep global model choices and unknown-time disclosure at their documented
  scope even when the visible Session selection is narrow.

Database pagination first retains the existing page-number API. Each request
has internally consistent totals and rows; concurrent publications can change
the ordering between page requests, as today. Keyset pagination is a separate
API choice if deep-page cost warrants it. A cursor alone would not guarantee
a frozen multi-request snapshot.

Remove the transferred-fact cap only when the aggregate path has its own measured
resource envelope and deadline behavior. Indexed reads still scan matching rows;
this design does not make arbitrary histories constant-cost. Avoid loading the
entire Session directory in the aggregate path: use authorized SQL scopes for
selection and distinct directory queries for options. If exact complete option
directories exceed the response budget, design searchable, paginated options as
a separate compatible Interface increment rather than silently truncating them.

## Delivery and acceptance

1. **Establish a baseline.** Finish the existing local increment's relevant PR
   gates. Once separately authorized and deployed, measure endpoint latency,
   database stages, connection waits and errors on representative requests.
2. **Indexed facts.** Implement preparation, bounded backfill, fallback and
   reclamation tests. Preserve the existing API, Go aggregation and limits. Show
   that covered statistics paths no longer decode publication bodies, and compare
   cold reads as well as warm reads. Preview decoding remains intentional.
3. **Aggregation and paging.** Replace the persistence Interface and raw-fact
   transfer, then validate exact metrics/page equivalence before lifting limits.
   Land this increment independently of the facts change.
4. **Remaining measured costs.** Consider model/unknown-time summaries, searchable
   option directories or caching only when diagnostics establish their priority.

Each implementation increment must pass its caller-facing contracts and relevant
real PostgreSQL checks. Integration, migration and deployment are separate steps;
this proposal does not authorize them.

Correctness evidence must include mixed native/published data, retries, empty
parts, child Threads, split root messages, partial/unknown Tokens, combined
filters, both model periods, head replacement, deletion and revoked access.
Compare the old and new results on the same fixed dataset/snapshot. Exercise
backfill crashes/retries, old writers, candidate activation during backfill and
reclamation races through the owning Module Interfaces.

Performance evidence must include the current approximately 60,000-message shape
and larger histories beyond today's cap, large publication bodies, many small
Sessions, large option directories, narrow selections and concurrent publication.
Record endpoint p50/p95, query plans and temporary I/O, Go allocations, connection
waits, and validation/WAL/storage/reclamation overhead under a declared load and
environment. Define a latency target against that workload before acceptance;
single local query samples are neither an endpoint SLO nor a capacity guarantee.
