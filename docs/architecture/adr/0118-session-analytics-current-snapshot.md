# ADR-0118: Session Analytics from one current Canonical snapshot

- Status: Accepted
- Date: 2026-10-10

## Context

Session analysis needs tool outcomes, conversation structure, usage and evidence
that can be opened in the reader. Overview facts deliberately omit tool and
thought content, and Search is an eventually updated read model. Neither is a
complete authority for this operation. Raw is a separately authorized archive,
not an analytics input.

An activated publication provides one `current_head` for its normalized facts.
Legacy Session, Thread, Event and Usage revisions advance independently; a
Session revision or latest Event sequence does not identify the entire input.
Compression, replacement and rewrite must change analysis according to the
selected Canonical content, without rules for particular compression counts.

## Decision

Introduce a deep Go Session Analytics Module with one `Open` Interface. It owns
provider-independent metric semantics, evidence selection, bounded derivation
and pagination. HTTP and Web presentation translate its input and output. The
Module depends on a consumer-owned `Store.SessionAnalytics` Seam that returns
only its required Session, Thread, Event metadata and Usage facts together with
a source token. The PostgreSQL Adapter authorizes `conversation.read` and reads
all facts inside one read-only repeatable-read transaction. The demo Adapter
provides the same consistent operation.

| Approach | Depth, Leverage and Locality | Cost and decision |
| --- | --- | --- |
| Read-time `Open` over a narrow authorized snapshot | High Depth: callers see one operation. Leverage comes from existing Canonical records and authorization. Metric rules stay local to Session Analytics; persistence details stay local to its Adapters. The Store Seam is justified by the production PostgreSQL and demo implementations. | Selected for the first increment. Derivation has explicit capacity and response bounds; no migration, worker or persistent analysis result. |
| Derived indexed facts and asynchronous result publication | Can provide the same small public Interface and reduce repeated work. Adds a real writer/reader Seam, freshness validation, invalidation, worker lifetime and recovery. Locality requires one owner for these workflows. | Defer until measurements justify it. Any future key must bind source token and analytics version; a stale result must never appear current. |

The Store selects normalized publication facts only when `current_head` is
non-null. A source row or legacy adoption without an active head continues to
use legacy Canonical records. Publication tokens reuse the selected head.
Legacy tokens are a versioned deterministic fingerprint of all actual analysis
inputs, including independently changing Usage and Thread facts. They are
conditional tokens for current content, not a new aggregate generation or a
historical retention promise. The analytics algorithm has its own version.

Every evidence page reauthorizes and compares the source token before returning
data. Cursors bind Session, source token, analytics version and evidence filters.
The reader accepts the same optional conditional `snapshot` token, including
legacy Sessions. Changed content yields `409 refresh_required`; clients refresh
the whole analysis instead of combining different snapshots. A token grants no
access after membership or resource access is revoked.

Tool calls merge structured updates by `(Session, Thread, toolCallId)`. Missing
or unrecognized outcomes remain unknown; text and tool labels do not establish
success or failure. Tokens use Adapter-normalized inclusive counters and never
estimate missing usage. Unknown source clocks stay unknown. Partial capture is
disclosed separately from known recorded facts. No score, monetary cost,
duration-as-work-time inference or generated summary is introduced.

## Consequences and validation

This increment adds no Provider parser, Raw read, Search dependency or background
card queue. Capacity failures are explicit `422 analytics_capacity`, never a
silently truncated complete analysis. Tests cover public Module/HTTP Interfaces,
normalized and legacy snapshots, independent Usage changes, head replacement,
authorization concealment and conditional reader opening. The current contract,
limits and remaining product work live in
[Session Analytics](../../session-analytics.md).

This complements the indexed Team Overview facts selected in
[ADR-0085](0085-overview-indexed-facts-and-aggregation.md); it does not change
their scope or make them the authority for full Session analysis.
