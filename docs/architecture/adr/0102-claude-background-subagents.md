# ADR-0102: Claude direct background subagents

- Status: Accepted decision; implementation and verification belong to the Claude guide
- Date: 2026-10-09

## Context

[ADR-0087](0087-claude-foreground-subagents.md) admits completed foreground
children. [ADR-0098](0098-claude-current-thread-continuity.md) preserves a valid
parent around unsupported delegation. [ADR-0101](0101-claude-active-path-and-legacy-adoption.md)
provides complete current-path replacement, authenticated stream proofs and
retention of previously captured missing children. These mechanisms can express
a direct background child without adding another capture Interface.

Isolated Claude Code 2.1.263 [native evidence](../../../adapters/claude/fixtures/native-background-child-2.1.263/README.md)
shows an explicit `run_in_background: true` Agent invocation and an exact
`sourceToolAssistantUUID` launch receipt with `isAsync: true`,
`status: "async_launched"` and an Agent ID. The child records independently
identify the original Session/CWD, Agent ID and sidechain ownership. The parent
continues while the child runs. Completion appends a typed `task-notification`
user record on the current parent chain, rather than another Agent tool result.
The notification contains a result and aggregate usage and explicitly allows
later notifications for the same task ID. Its output-file locator was a symlink
to the child JSONL; neither that locator nor a sidecar proves ownership.

## Decision

Keep topology interpretation in the Claude Adapter Module behind sourceCapture
v2. Admit a direct background child only from a unique non-error root Agent/Task
result whose exact invocation explicitly requests background execution, whose
launch metadata agrees, and whose exact source assistant UUID and safe Agent ID
prove the relationship. Independently validate the child original header through
the existing derived subagent path. Preserve completed foreground admission.
Missing or contradictory evidence does not authorize discovering arbitrary files;
already pinned identity conflicts remain hard failures.

Link the child from the actual launch result Event. Read its complete-LF suffix
on each bounded source view, independently of parent-byte changes or completion
notifications. Reuse ordinary child graph, thinking, usage, prefix authentication,
current-path selection, Raw backfill and missing-child retention. Withdrawing the
launch receipt from the current root path withdraws its child membership. A
never-captured missing child produces a diagnostic without a fabricated Thread
or link. Completion never creates or reparents a relationship, and does not seal
the child against later valid appends. No lifecycle round counter is introduced.

A native typed task notification is provider control data. Validate its user
record shape and ordinary parent/identity correlation, retain its UUID as a graph
ancestor, and omit its body from the v2 Canonical projection. It is Raw-eligible.
Do not parse XML to infer relationships, admit files or create assistant usage.
Actual assistant acknowledgements and later genuine user turns remain ordinary
conversation. User-pasted notification-shaped text without the native typed
origin remains user content. A malformed typed notification must not disappear
silently, and a typed notification cannot reconnect to an abandoned parent using
the genuine-user rewind rule.

Keep this v2 projection choice separate from the shared legacy normalizer.
Historical collect projected notification text as a user Event, and its opaque
pending cursor can refer to one of those physical projection slots. Validate that
cursor against its historical projection without reinterpretation. Commit the
notification's ordinary user graph/response semantics before suppressing its v2
Events. Existing v2 checkpoints authenticate bytes rather than storing a fixed
projection; reopening the same proved source can withdraw the old notification
Event and admit the newly supported child through a complete replacement.

The shared Host already compares complete source metadata/checkpoints and opens
views without a root-mtime shortcut. Its existing publication workflow owns
delivery and recovery; the Server already owns atomic membership and retained
children. No Host, Server, API, SQL, checkpoint schema or manifest revision is
needed. This increases the Adapter's Depth and Leverage while keeping provider
rules local to its Implementation. Canonical, physical Raw and Search remain
separate concerns.

## Alternatives

1. Wait for completion before admitting a child. This loses running or interrupted
   history and makes valid capture depend on a notification that proves no new
   ownership.
2. Scan child directories, follow output-file paths or trust sidecars. These
   locators cannot establish the relationship and broaden filesystem authority.
3. Admit the launch-owned child and independently capture its authenticated
   stream through the existing complete view. Choose this design.

## Verification and limits

Verify through public factory/sourceCapture and installed collection Interfaces.
Distinguish simultaneously observed native snapshots from derived complete-LF
prefix replays and generated failure mutations. Cover running capture,
root-unchanged child append, parent continuation, notification exclusion, genuine
user lookalikes, usage once, restart, partial LF, Raw off/backfill, missing-child
retention/restoration and rewind withdrawal. Preserve conflicting-identity and
changed-prefix rejection. Use genuine previous-main v2 and historical legacy
artifacts for upgrade and pending-cursor evidence. Authenticated HTTP/PostgreSQL
checks establish Reader/Search membership, stable parent anchors and independent
physical Raw availability. The Claude guide records checks actually run.

This evidence covers one direct background lifecycle, not native failure,
cancellation, repeated notification, nested delegation, child fork, cross-file
Session adoption or arbitrary spill collection. Those limits do not require
special handling for a fixed number of compactions. Package publication and
Server deployment remain separate actions.
