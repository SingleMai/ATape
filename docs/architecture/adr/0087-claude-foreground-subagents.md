# ADR-0087: Claude foreground subagents on legacy capture

- Status: Accepted scope; implementation and acceptance are recorded in the feature guide
- Date: 2026-10-08

Later amendment: [ADR-0101](0101-claude-active-path-and-legacy-adoption.md) replaces
Claude's legacy writer with explicit sourceCapture v2 adoption and base-bound
retention. This record describes the earlier additive increment; the current
[Claude guide](../../adapters/claude.md) owns supported behavior.

## Context

[ADR-0023](0023-claude-source-conversation-topology.md) describes the broader Claude
record graph, while [ADR-0029](0029-claude-first-vertical-slice.md) delivered linear
root histories through the existing paged Collector. Existing Claude Sessions,
Event identities, appendable Raw objects and opaque checkpoints use legacy batch
ingestion. An upgrade must preserve them.

The next usable increment captures ordinary completed foreground subagents whose
ownership is proved by the root conversation. It does not require replacement of
previously visible Events or changes to a published Thread's parent. Legacy
ingestion can therefore express this increment without migrating write mode.
Rewind and general Active Path replacement still need the publication capability
described by [ADR-0025](0025-atomic-canonical-publication.md). The source runtime
in [ADR-0068](0068-source-capture-runtime.md) is not an implicit migration path for
already captured legacy Sessions.

## Decision

Keep Claude's legacy `collect` runtime and extend its private source
Implementation to read a bounded, proved foreground family. The public Adapter,
Collector, Canonical, Raw and reader Interfaces remain unchanged. Provider
knowledge stays in the Claude Adapter; the Host continues to own attribution,
redaction, uploads and checkpoint commits.

- A root `Agent` or `Task` invocation and its successful result must correlate by
  tool-use identity and exact `sourceToolAssistantUUID`. The result's native
  `toolUseResult.agentId` identifies the child, its status must be `completed`,
  and an asynchronous or error result is not admitted. A filename or directory
  location alone is not ownership evidence.
- The child file is selected below
  `<root-file-directory>/<sessionId>/subagents/agent-<agentId>.jsonl`. Its native identity and
  relationship metadata must agree with the root evidence. Source paths remain
  local locators, never Canonical identity or Project authorization.
- The root's original CWD and shared Host attribution own the whole proved
  family. A child's current CWD cannot move it to another Project. Unknown or
  conflicting child ownership is a source diagnostic, not an independent root
  Session or a guessed relationship.
- Each admitted child becomes `claude-agent:<agentId>` below the existing `root`
  Thread. Its reference attaches to the actual parent tool-result Event. Do not
  fabricate a spawn message or reuse a copied root message as delegated input.
- Parentage is fixed before first publication. Nested delegation, background or
  interrupted child runs, forks, compaction and rewind are outside this increment.
  Do not publish a temporary parent that legacy ingestion cannot later correct.
- Each physical child stream has independent bounded prefix verification,
  Canonical pagination and Raw progress. Root and child appends retain stable
  record/block-slot identities within their own Thread namespaces. Missing
  sources retain captured history and committed progress.

The discovery cursor remains version 2. Its Session checkpoint gains optional
`children` entries containing `agentId`, `toolCallId`, `toolUuid` and an independent
child `checkpoint`, plus `childAfter`, `familyRevision` and `familyObservedAt`
metadata. Existing version-1 single-file and version-2
discovery cursors continue to decode and verify their committed prefixes.
Root Session/Thread/Event keys and existing Raw object identity/generation are
unchanged. Projection revision 4 replays older supported projection versions once
to discover proved foreground receipts while retaining the existing Event keys.
Child Raw object identities use the `claude-agent-rollout` namespace and a digest
of the root Session ID, original CWD, child root UUID and Agent ID. As in
[ADR-0032](0032-claude-release-and-recovery.md), package-version
changes do not reset supported progress; unknown schemas, ownership conflicts
and changed prefixes remain explicit failures.

This is an additive capture increment. It does not turn bounded legacy pages into
an atomic family replacement, withdraw omitted Events, reparent published Threads,
or recover delivery without the required source bytes. No new journal, provider
server operation, implicit write-mode migration or second uploader is introduced.

## Alternatives

- Switch the entire Claude Adapter to source capture immediately: the current
  Host rejects legacy checkpoints and the Server rejects a legacy Session's mode
  change. Doing so without an explicit migration would strand existing capture.
- Upload each child as another root Session: loses the proved delegation and
  assigns Project ownership using evidence that belongs to the actual root.
- Infer children from the directory tree: cannot prove ownership or completion
  and risks capturing unrelated, stale or unsupported child histories.
- Add proved foreground children to legacy capture (selected): preserves Depth
  and Locality in the provider source Implementation, while callers gain child
  navigation through the existing Interface.

## Verification and remaining scope

Verification uses the production Adapter and installed Collector Interfaces:
root-to-child navigation, stable IDs, bounded multi-page replay, independently
pending Raw, Raw off/on, source deletion, old cursors, package replacement,
attribution and isolated malformed or conflicting children. Native fixtures must
record the sampled Claude version and distinguish controlled native output from
synthetic mutations. Planned or generated fixtures are not passed acceptance.

The [Claude guide](../../adapters/claude.md) owns the actual supported profile and
checks completed for this increment. Broader graph semantics require further
native evidence. Full Active Path replacement additionally requires an explicit
legacy-to-publication migration preserving Session identity, reader links, Raw
ownership and visible history until successful activation. Implementation,
integration, publication and deployment remain separate states.
