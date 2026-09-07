# ADR-0020: Derived Conversation Narrative

- Status: Accepted
- Date: 2026-09-07

## Context

ATape captures conversations from heterogeneous agent systems. Canonical v1
therefore stores a Session, its Thread tree, and source-ordered Events. Some
sources expose a native Turn while others do not, and the accepted Canonical
Interface intentionally does not require one.

Rendering every Event as equal primary content makes a Session hard to read:
tool calls, thoughts, lifecycle updates, and intermediate agent messages can
overwhelm the User prompt and the Agent's delivered response. The reader needs
a stable interpretation while Canonical Events and Raw source data remain the
authoritative records.

## Considered Interfaces

### Add Turn and final-response fields to Canonical v1

This would give presentation an explicit structure, but it would require
Adapters to invent source semantics and would change ingestion, persistence,
and API contracts. It also cannot represent sources that have no native Turn
without pretending that a heuristic is Canonical truth.

### Group Events inside each React view

This avoids a protocol change, but duplicates semantic rules in Presentation.
Search, exports, and future readers could then disagree about which content is
primary or hidden.

### Derive a Conversation Narrative in the domain package

A pure Module can project a current Conversation snapshot into compact reading
groups. Its narrow Interface accepts Canonical data and returns
`NarrativeExchange` values without persistence, remote calls, or a new Adapter
Seam. Presentation only renders the result.

## Decision

ATape uses a derived Conversation Narrative for the default Session reader.

- Canonical v1 remains Session → Thread → ordered Events. No Turn, role, or
  final-response field is added.
- `projectConversationNarrative` is a pure domain Module. Its output is neither
  persisted nor accepted by ingestion APIs.
- A recognized User message starts a `NarrativeExchange`. Events before the
  first recognized User message form a `thread_start` exchange.
- The last recognized Agent message in an exchange is presented as its primary
  response. "Primary" is a reading choice, not a claim that the source marked
  the message final.
- Earlier Agent messages, thoughts, tool activity, context, and lifecycle
  events are available under one collapsed Activity disclosure.
- Artifacts, notices, child-thread relationships, and messages whose author
  cannot be classified remain visible outside Activity.
- Incomplete and ambiguous captures do not invent a prompt or response.
- Search still anchors to Canonical Event identity. When a result targets an
  Activity Event, the reader opens the containing disclosure.
- Raw remains the complete audit view and source order remains authoritative.

## Consequences

- The default reader emphasizes the human conversation without weakening the
  audit path.
- Adapter-specific Turn concepts may improve future projections, but are not
  required by Canonical v1.
- The projection can evolve independently of persisted data and can be rebuilt
  from the current Conversation snapshot.
- Narrative consumers share one interpretation instead of recreating grouping
  rules in Presentation.

## Rejected Alternatives

- **Canonical Turn records**: overstates semantics not supplied by every source
  and creates a breaking protocol change.
- **Presentation-owned grouping**: weak Locality and allows readers to drift.
- **Hide every non-primary Event**: loses notices, artifacts, ambiguous
  messages, and child-thread navigation that users need to see.
