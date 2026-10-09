# ADR-0090: Claude exact-two Read result parents

- Status: Accepted scope; implementation and acceptance are recorded in the feature guide
- Date: 2026-10-08

## Later decision

[ADR-0097](0097-claude-compaction-continuity.md) supersedes the sample-specific
compaction admission and recovery policies with source-identity continuity.
The original source evidence and checks below retain their recorded scope.
The [current Claude guide](../../adapters/claude.md) owns implementation and
acceptance of the later decision.

## Context

Native Claude Code 2.1.263 splits one assistant response containing two Read
calls into adjacent assistant records. Its two following result records each
name their own call in both parentUuid and sourceToolAssistantUUID. Those edges
are not the preceding physical record. Ordinary strict linear collection stops
at the first result, leaving the actual final and resumed answers uncaptured.

Two controlled source cases establish [Read@0, Read@1] and the independent
[text@0, Read@1, Read@2] layout. Both execute actual Read against synthetic files
through a loopback model mock. Results are adjacent, successful and in call order.
Model requests contain both results once, but request assembly changes the
second result's formatting; raw result/request byte equality is not asserted.
Neither source contains compaction. The older text-plan case records isolated
configuration/workspace but does not establish a fresh HOME.

## Decision

Keep the public Claude Adapter Module Interface, legacy capture and projection
revision 4. Admit only these two root layouts inside the source Implementation.
No new Host/Server Seam, uploader, cursor reset or provider topology in Go is
needed. Canonical, Raw and Search keep their existing ownership.

At a non-linear first result R0, stream exactly the currently committed source
prefix through the same open handle, hash those bytes and retain a bounded
LF-framed tail. Compare the current digest before decoding the last calls.
Include calls committed on the current page; an Event-only or usage-pending
call is not in this proof. Do not authorize parents from the global call map
alone or read a separate unauthenticated tail after hashing.
The first-result candidate also requires zero eventSkip before proof/admission;
no legitimate single-result progress exists before its whole-record commit.

The final two physical records must be distinct root Read calls C0/C1 at API
indices 0/1, or indices 1/2 with the immediately preceding single text0 record
P from the same API ID/model/assistant role. C1 is parented by C0; in the latter
layout C0 is parented by P. All witnesses carry version 2.1.263, selected
Session/CWD identity, isSidechain false and the sampled non-compaction flags.
Their assistant stop reason is tool_use, including the optional plan record.
Call IDs and UUIDs must agree with fully committed call metadata. The two tool
IDs must be distinct. Existing ordinary admission rejects reuse of a known
tool ID; the bounded proof does not assert a separate whole-history uniqueness
audit for arbitrary acknowledged cursors.

R0 is a new native root user record with one successful tool_result, absent
is_error, matching tool ID, parent and sourceToolAssistantUUID C0, a valid
prompt identity and text/file receipt whose literal file path equals C0's Read
input. Source text is retained, never regenerated from disk or numbered output.
The Adapter does not read the referenced file or require it to remain present.
The sampled receipt omits asynchronous, Agent identity and status markers;
conflicting known markers are unsupported even when it also contains text/file.
File line counters are positive safe integers with the returned range inside
totalLines; malformed or zero-line metadata is outside this narrow profile.

Project the ordinary single tool_call_update and commit R0 separately. Only
after its full Event, usage and exact bytes/hash/offset commit, save a small
versioned private readPair state binding R0, C1, its tool ID/file path and their
shared prompt. End that page so an invalid later result cannot cancel returned
R0 progress. The next complete physical record must be R1 with the matching
own-call parent/source/tool/path/prompt evidence. No blank, bookkeeping,
compaction, external user or other tool record may intervene. Clear the state
only at R1's full record commit, then ordinary linear chaining resumes.

The stage is valid only on resumable projection-4/usage-version-1 root cursors
whose last UUID is R0, final seen UUIDs are C0/C1/R0 and committed Read metadata
matches C1. It is incompatible with manual/automatic compaction or child state.
Its eventSkip is zero: these user-shaped receipts have one Event and no
assistant usage, so a positive skip has no legitimate pending-record meaning.
Malformed recognized state fails cursor validation without fallback or reset.
Existing v1 Session, v2 discovery and compressed cursors remain supported.

At EOF after C1 there is no result stage to invent. After committed R0, missing
or partial R1 remains one pending Canonical Session without a busy continuation
loop. A wrong complete R1 preserves the acknowledged R0 cursor. Each receipt
retains ordinary complete-record, Event and requested source budget admission;
the two receipts do not have to fit together in a page. Independent Raw receipts
can advance through admitted bytes while the Host retains an older parser
cursor; normal retry proves R0 again and resumes the exact Raw object.

Call/plan proof records have a separate 64 KiB including-LF policy and a bounded
256 KiB retained byte tail. Decode at most three physical records; irrelevant
older records need not fit the witness cap. Receipt parsing retains ordinary
16 MiB bounds. The persisted literal file path is nonempty, NUL-free and at most
64 KiB of UTF-8 as an Adapter cursor/profile policy, not a native path limit.
Large tool output follows existing bounded Canonical details
policy and full Raw capture where enabled; it is one update, not fabricated
text fragments. Prefix proof costs O(committed prefix) I/O/hash with bounded
retained memory. Same-handle hashing does not provide a frozen filesystem
snapshot or remove inherited concurrent-writer limits.

## Alternatives and consequences

- Atomic two-result admission avoids private pending state, but cannot naturally
  acknowledge each ordinary Event under one-Event pages. It also delays a valid
  R0 until R1 exists and couples source capacity to both receipt sizes.
- Stateless tail inference on every collection avoids a cursor field but must
  reread even idle/ordinary pages to enforce pending R1 before linear-looking
  incompatible records. It complicates current-prefix caching and ownership.
- General old-call parent permission from calls would admit unrelated branches,
  unproved tool batches and stale results. It is rejected.

The selected state gives Leverage through the existing Interface and keeps
Depth and Locality in the Claude Adapter. Existing physical block-slot Event
IDs, latest-revision API usage, Reader tool associations, Search anchors and Raw
identity/generation remain stable. Splitting one API response across two or
three records updates one usage identity instead of summing repeated counters.

## Verification and remaining scope

Verify both native layouts through the public Adapter, one-Event pages, fresh
runtimes/retries, partial/EOF cuts, Event/usage/source limits, current-prefix
changes, old opaque checkpoints and independent Raw recovery. Verify the
installed tarball and managed Collector on authenticated HTTP/PostgreSQL at
each call/result boundary, including latest usage across separate deliveries,
Reader result anchors/associations, exact message-body Search anchors, tool
exclusion from Search, Raw bytes and unchanged pending polls.

The [Claude guide](../../adapters/claude.md) records actual acceptance and integration. This profile
does not admit more calls, reverse/interleaved/error/async results, other tools,
child batches, auto tool replay, forks/rewind or Active Path replacement. It does
not globally reject every new result that the older ordinary linear profile
already accepts. Package publication and Server deployment remain separate.

[ADR-0091](0091-claude-read-turn-automatic-replay.md) separately composes fully
committed Read pairs with a sampled first-slug automatic replay group.
[ADR-0095](0095-claude-reversed-read-pair-results.md) later selects planned
reverse completion and adoption of an already acknowledged first result.
