# ADR-0088: Claude manual compaction on legacy capture

- Status: Accepted scope; implementation and acceptance are recorded in the feature guide
- Date: 2026-10-08

## Context

[ADR-0023](0023-claude-source-conversation-topology.md) describes the wider Claude
record graph. [ADR-0029](0029-claude-first-vertical-slice.md) and
[ADR-0087](0087-claude-foreground-subagents.md) retain legacy capture and its
existing Session, Thread, Event, Raw and checkpoint identities. Legacy ingestion
cannot withdraw a previously visible Event or replace a complete Active Path.

A controlled native Claude Code 2.1.263 corpus now demonstrates a narrower
manual `/compact` case: the source keeps its entire original byte prefix, appends
a boundary with an explicit logical parent, then appends an internal summary,
local command controls and a synthetic assistant bridge before ordinary turns
continue. There is no copied UUID replay or withdrawal of old conversation data.
This case can be captured additively without migrating existing Sessions.

A second controlled run preserves two physically adjacent assistant records
from one API response. Each carries one nonempty text block, with API block
indices 0 and 1 and a direct parent edge. Both UUIDs already occur in the
committed prefix; the boundary names them in order without copying either
record. This is a second bounded tail shape within the same manual profile.

The source runtime in [ADR-0068](0068-source-capture-runtime.md) is not such a
migration. The current Host rejects legacy checkpoints in source mode, and the
Server excludes legacy Sessions from publication reservations. A future switch
needs a generic explicit transition that preserves opaque progress, Raw ownership
and visible history until successful activation. Changing a manifest or deleting
the cursor does not supply that transition.

## Decision

Keep Claude's legacy `collect` Interface and add one fixture-proved root manual
compaction profile to its source Implementation. Provider topology remains local
to the Claude Adapter Module. The Host still owns attribution, redaction,
Canonical/Raw delivery and checkpoint commits; no new uploader or Server Seam is
introduced.

- The previously committed source prefix must remain byte-identical. Admit a
  root `system` / `compact_boundary` record only for the sampled version
  `2.1.263`, with `compactMetadata.trigger: "manual"`, `parentUuid: null` and
  `logicalParentUuid` equal to the current unique last UUID in that stream.
- Admit either a singleton whose segment endpoints and both preserved UUID
  arrays equal that last UUID, or the exact two-record text tail above. For the
  pair, both arrays must equal the ordered head/tail UUIDs, the segment endpoints
  must match and the tail must be the current last UUID. Both metadata anchors
  must identify the immediately following summary UUID. No copied records,
  arbitrary longer segment or cross-file join is admitted.
- Prove a two-record tail from source bytes, rather than treating seen UUIDs as
  semantic evidence. At the boundary, stream the currently committed prefix
  through the same open file handle, hashing those exact bytes while retaining
  at most two UUID-record proofs and their physical record positions. Compare
  against the current committed prefix hash, including records newly committed
  on this page. Both records must have native root identity, version 2.1.263,
  the same valid API ID, assistant role and model, indices 0/1 and one nonempty
  text block each. The second parent must select the first and their physical
  records must be adjacent. UUID-less bookkeeping after the pair can remain
  in the prefix; bookkeeping between the two records breaks adjacency.
- The summary must be a root user record parented by the boundary, carrying
  `isCompactSummary: true` and `isVisibleInTranscriptOnly: true`. Accept only
  the fixture-proved continuation: summary, local-command caveat, `/compact`
  command, local-command stdout, then the native zero-token `<synthetic>`
  assistant `No response requested.` bridge. Each UUID edge remains strict;
  unrelated metadata records do not establish a replacement parent.
- The boundary, internal summary, command controls and synthetic bridge are
  Raw-only. They do not become ordinary user/assistant Events, a fabricated
  compaction message or billable usage. The summary is actually loaded in the
  next model request; Raw-only describes Canonical semantics, not whether the
  model sees it. Ordinary real turns after the bridge append to the same root
  Thread while the existing pre-compaction history remains visible.
- This filtering applies only inside the admitted compaction state machine.
  Ordinary records outside it retain their existing projection. An unbound
  compact summary is unsupported rather than silently accepted as Raw-only.
- Keep the existing root Event keys, source-order coordinates and appendable
  Raw object. Physical control records still advance source progress. This
  profile neither removes old Events nor re-keys the Session or its children.

The existing cursor versions and projection revision 4 remain supported. An
optional stream `compaction` state records `v: 1`, `boundaryUuid`, `summaryUuid`,
`phase` (`summary`, `caveat`, `command`, `stdout` or `resume`) and the prompt
identity once observed. Stage, last UUID, seen UUIDs, prefix hash, byte offset
and physical record order advance together only after a complete record is
accepted. A page ending at any stage can recreate the runtime and resume without
publishing a partial control record or forgetting the required next UUID.
The two-record proof neither reprojects acknowledged Events or usage nor adds a
cursor field or projection revision. A fragmented conversation record enters
the proved prefix only after all its Events and usage have been admitted.

An unfinished source can retain the stage and poll for the remaining records;
it does not fabricate Canonical progress. A conflicting next UUID or native
marker is an unsupported-source diagnostic and preserves acknowledged progress.
Captured Raw remains governed by the current Raw policy and normal independent
upload receipts. Adding an optional private cursor field does not justify a
forced replay of unchanged projection-4 prefixes.

## Alternatives and consequences

- Switch Claude to source capture first: requires coordinated Host and Server
  adoption of already published legacy Sessions, old Raw receipts and source
  baselines. That larger transition is necessary for replacement semantics,
  but this additive case does not require it.
- Treat the boundary's null parent as a new root or flatten arbitrary file
  order: breaks the established chain or admits unrelated branches.
- Project the summary as user text: attributes provider-generated context to
  the user and duplicates the retained conversation in Reader and Search.
- Admit only the exact manual append profile (selected): preserves Depth and
  Locality within the source Implementation and uses the existing caller
  Interface, with deliberately narrower compatibility.
- Persist a new semantic tail ledger in every cursor: avoids a boundary reread
  but expands durable compatibility and requires recovery for old checkpoints.
  The selected lazy source proof keeps the Interface and checkpoint unchanged,
  at the cost of one extra streaming pass over the committed prefix for each
  newly encountered two-record boundary. Memory stays bounded by record limits;
  this does not establish an atomic snapshot against concurrent source rewrites.

The compaction model response itself has no assistant record in this corpus.
Its actual token usage cannot be recovered from JSONL. `compactMetadata` counts
describe context bookkeeping, not an assistant usage record; do not turn them
into usage. Only real recorded assistant responses contribute usage. The native
synthetic bridge's zero counters do not create a usage item.

## Verification and remaining scope

Verify through production Adapter, Collector and installed-package Interfaces:
capture before compaction, append the native compacted snapshot, append real
continuation, restore the runtime at every bounded page, verify stable old IDs,
no summary/control Search Events, actual assistant usage, unchanged polling,
independent Raw off/on recovery and complete captured source bytes. Exercise
supported old cursors without resets, unfinished stages, malformed or conflicting
markers, automatic triggers, invalid same-response pairs, longer preserved tails
and prefix rewrites. Split records retain distinct Event identities but their
shared API usage ID is an upsert: aggregate the latest revision once, including
when the two records fall on different pages.

The [Claude guide](../../adapters/claude.md) records actual implementation and
checks. The native corpora sample singleton and exact two-record text tails on
Claude Code 2.1.263 with a loopback model mock. They do not establish auto-compaction,
cross-file continuation, child compaction, copied replay, rewind, forks, broader
version support or real-provider billing. General Active Path replacement still
needs an explicit legacy-to-publication migration. No package publication or
deployment is implied by this decision.
