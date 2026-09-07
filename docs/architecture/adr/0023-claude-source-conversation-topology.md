# ADR-0023: Claude Source Conversation Topology

- Status: Accepted design; see ADR-0029 for the implemented subset
- Date: 2026-09-07

## Context

Claude Code stores a logical conversation as a record graph rather than a reliably linear file. Rewind leaves Historical Branches in the same transcript, compaction may replay records or continue across physical files, explicit fork operations create new Session IDs with copied prefixes, and subagents have their own transcripts. Flattening every record by file order would mix incompatible paths, while treating every physical file or copied prefix as globally duplicate would break Session identity and replay.

ATape needs a provider-specific topology rule that fits the existing Captured Session and Captured Thread model without making Raw Source Data, Canonical history, and presentation responsible for each other's concerns.

## Decision

The Claude First-party Adapter projects one source-indicated Active Path as the root Captured Thread of a Captured Session. Historical Branches created by rewind remain losslessly available in Raw Source Data but do not enter the default Canonical timeline in the first release. They are not represented as subagent Captured Threads.

- The Adapter identifies the Active Path from a current-version, fixture-verified source leaf signal and walks the record-parent graph. It never treats file order or the newest timestamp alone as the active conversation. Ambiguous leaf selection degrades the affected projection rather than flattening competing paths.
- Physical transcript segments merge into one Captured Session only when a current-version, fixture-verified continuation edge uniquely links them and their Project attribution agrees. Ambiguous cross-file relationships remain separate Captured Sessions with degraded lineage fidelity; false splits are preferred over false merges.
- Publication boundary clarified with the user on 2026-09-07: the Adapter may group unpublished segments or attach an unpublished, verified continuation to an established Session, but the first release does not retrospectively merge Sessions already published under separate identities. This preserves their existing Canonical/Raw ownership and reader links. Continuation/fork classification and source-to-Session mapping belong entirely to the provider Adapter; the Host persists opaque progress and handles delivery, while the server accepts stable Session keys and generic Canonical updates without interpreting continuation semantics or providing a Claude-specific merge operation.
- An explicit Claude branch or fork creates a distinct, self-contained Forked Session. Its copied prefix is projected again under the new Session namespace. ATape does not require a cross-Session parent relationship to ingest it.
- Each ordinary Claude subagent becomes a child Captured Thread. A fixture-verified tool-use relationship establishes nesting. If the subagent is valid but its exact parent cannot be established, it becomes a Detached Subagent Thread under the root Captured Thread and reports degraded relation fidelity; the Adapter neither drops it nor guesses a nested parent.
- Claude workflow artifacts are preserved as Raw Source Data but receive no workflow-specific Canonical Session, Thread, or Event projection until the current Claude version has a sanitized fixture corpus and a separate accepted topology decision.

Stable identity is now specified by the identity contract (retained as local research evidence): source-namespaced record UUIDs plus versioned source-coordinate projection slots, pinned logical group anchors before remote publication, and durable bounded ownership metadata rather than a per-Event identity ledger. Coordinate slots do not promise semantic block tracking through arbitrary source reordering. Shared revisions follow ADR-0025; exact Canonical mapping, capture-status transitions and durable checkpoint mechanics remain separate decisions. No production Implementation is claimed.

If newly verified fork/source topology contradicts an existing group pin, stop the affected capture and preserve published history for recovery. Do not keep publishing through a known-wrong merged identity, and do not implicitly split/re-key the old history. This is an ownership conflict, distinct from uncertain evidence that can conservatively remain unmerged.

## Consequences

- The default conversation view follows what Claude was actually continuing instead of interleaving abandoned rewind paths.
- Complete provider evidence remains available for future Historical Branch or workflow views without expanding the first Canonical model prematurely.
- Forked Sessions are independently readable and replayable at the cost of intentionally repeating copied-prefix Canonical content across Session namespaces.
- Conservative ambiguity handling may split a real continuation or flatten a Detached Subagent Thread to the root, but it cannot silently merge unrelated conversations or invent ancestry.
- Evidence arriving after separate publication can leave a real continuation represented as separate Sessions. The Adapter reports degraded lineage rather than moving already published history; ordinary future updates and unpublished continuation segments are not blocked by this restriction.

## Rejected Alternatives

- **Flatten every JSONL record into one root Thread**: mixes rewind paths, structural callbacks, and replay artifacts into a conversation Claude never presented.
- **Represent Historical Branches as subagent Threads**: overloads the child Thread relationship and makes rewind history indistinguishable from delegated work.
- **Treat every transcript file as a distinct Captured Session**: breaks source continuations that are explicitly linked across files.
- **Remove copied fork prefixes as duplicates**: makes a Forked Session depend on another Session and conflicts with Session-scoped Canonical identity.
