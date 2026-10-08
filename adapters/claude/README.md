# Claude Code Adapter

Discover Project-scoped Claude Code JSONL Sessions through ATape's normal
Collector, shared ACP profile, server and existing conversation page.

```sh
pnpm --filter @atape/adapter-claude build
pnpm atape
```

In **Tools and updates**, add Claude to the existing global selection and review
the affected Projects. Installing an Adapter alone does not enable collection.
In Tools and updates, use Choose tools to sync;
tool selection applies to every connected Project.

For an offline packaged installation, `pnpm pack:release` produces the CLI and
official Adapter tarballs plus `SHA256SUMS` under `release/`. Install the matching CLI
tarball, then install the Claude Adapter tarball path in Tools and updates → Integration maintenance.
These local build commands do not publish to npm or deploy an instance.

The Project must already be configured and authenticated normally. Discovery reads
`~/.claude/projects/*/*.jsonl`; set `ATAPE_CLAUDE_HOME` to an absolute alternate
Claude configuration directory when needed. `ATAPE_CLAUDE_SESSION_FILE` remains
an optional absolute single-file override, useful for controlled capture or
diagnosing a file outside the discovery profile.

A discovered file is not permission to upload it to an unrelated Project: its
original root CWD must belong to the configured ordinary directory, or the shared
Host must match its original Git remote to the configured Project. Git matching
includes linked worktrees and independent clones and excludes nested unrelated
repositories. Later `/cd` values do not reassign a Session. The Host preserves
confirmed evidence across origin changes and directory deletion; an unavailable
original directory without established evidence is reported as `attribution`.
Both CLI and Adapter must support `atape.git-attribution.v1` for Git capture.

## Supported now

- Automatic discovery under enabled Projects. Directory names do not determine
  attribution. Discovery inspects up to 256 records / 64 MiB per file for the first UUID record
  and checks its original CWD before streaming the Session. Symlinked
  files/directories are not traversed. Ordinary foreground child files are read
  only after the root proves their relationship; other subagent directories are
  not recursively scanned.
- One changed Session per page, with round-robin scanning and per-Session progress
  in the existing Collector checkpoint. Reopening the Adapter preserves progress;
  unchanged Sessions are not re-uploaded. New files and appends are discovered on
  subsequent collections. Moving a file does not create a new Session; missing
  files retain their checkpoints and captured history. Existing single-file v1
  checkpoints are carried forward without resetting their committed prefixes.
- A root with append-only local history, the narrow two-Read and manual/automatic compaction profiles
  below and proved ordinary foreground
  child streams, all with valid UTF-8 JSONL. A correlated successful `Agent` or
  `Task` result's `toolUseResult.agentId` selects the child at
  `<root-file-directory>/<sessionId>/subagents/agent-<agentId>.jsonl`. Admission
  requires status `completed`, no asynchronous/error result and exact
  `sourceToolAssistantUUID` correlation. The child's first record must agree
  with the root Session ID and original CWD and declare the selected Agent ID
  and `isSidechain: true`. The `.meta.json` sidecar is not read. The child becomes `claude-agent:<agentId>` below `root`,
  linked from the real parent tool-result Event. The root's original attribution
  owns this family; directory location or a child CWD does not authorize it.
- User/assistant text, tool call/status summaries and bounded tool input/output.
  The shared reader displays Input/Output in collapsed, escaped text/JSON details.
  Correlation IDs link call and result within their Session/Thread. Host redaction
  runs before Canonical encoding; null, false, zero and empty values stay distinct
  from absence. Values beyond 64 KiB / depth 32 / 10,000 nodes remain only in Raw.
  Unknown contents and nonempty thinking also remain Raw. Tool-bearing projections
  retain their conservative partial status; this is not complete ACP content support.
  Search matches user/assistant message bodies; tool summaries, labels and full
  input/output are excluded. Reader retains exact tool Event anchors and details.
- Stable record UUID + physical block-slot Event identities; replay does not
  duplicate messages. Same-model-message split records remain distinct.
- Complete-line eligibility, bounded record pagination and existing
  Host secret redaction before Canonical/Raw network requests.
- Stable appendable Raw objects and per-record Canonical progress. Appends send
  only new records; large text records split across bounded Canonical pages.
  Existing immutable Raw snapshots remain available after checkpoint migration.
- Independent child prefix verification, Canonical pagination and Raw progress.
  The version-2 discovery cursor adds optional child metadata while retaining
  version-1 single-file and existing version-2 recovery. Existing root Session,
  Thread, Event and Raw keys are preserved. Missing child sources retain captured
  history and their committed checkpoints.
- Native manual root `/compact` on Claude Code 2.1.263, retaining the original
  byte prefix and visible conversation before appending real continuation turns.
  A null-parent `compact_boundary` must explicitly name the current last UUID
  as its logical parent. The preserved tail is either that single UUID or
  exactly two physically adjacent assistant records from the same API response,
  with matching role/model, indices 0/1, one nonempty text block each and a direct
  parent edge. Both preserved UUID arrays and segment endpoints must name that
  tail in order. The Adapter proves the pair from the currently committed source
  bytes, without replaying old Events/usage or changing checkpoints. The preserved
  anchors select
  the next user-shaped summary, which must have `isCompactSummary` and
  `isVisibleInTranscriptOnly` set. A strict checkpointed state machine accepts
  the native summary → caveat → `/compact` command → stdout → zero-token
  `<synthetic>` `No response requested.` bridge chain. These internal controls
  stay Raw-only; real turns afterward use the existing root Thread. The summary
  is actually loaded by the model, but is not attributed to the user in Reader
  or Search. An unfinished stage waits for the remaining source append; a
  conflicting edge or marker is unsupported. The existing projection revision
  4 and root/child identities remain unchanged.
- Native automatic root text compaction on Claude Code 2.1.263 with exact retained
  [assistant A, user U, token-reminder attachment G], direct A → U → G parents
  and adjacent U/G. Source copies U/G, then appends fresh boundary B and summary
  S selecting this current tail and U's prompt. Copies preserve all decoded
  values: they only add a shared slug to originals without one, or preserve the
  existing common slug unchanged. Same-byte prefix proof authenticates the
  bounded original tail; arbitrary repeated UUIDs remain unsupported. All four
  control records commit together and stay Raw-only. An optional private
  checkpoint requires the next real text answer parented by S, retaining it
  through fragmentation/deferred usage until the full record commits. Each later
  round needs new current-tail proof and unseen B/S. Existing chronological
  Events, usage identities, Raw receipts and projection-4 checkpoints remain;
  copied users and internal summaries do not become extra Reader/Search turns.
- Native Claude Code 2.1.263 root responses with exactly two successful Read
  calls in the sampled order: `Read@0, Read@1`, or `text@0, Read@1, Read@2`.
  The following results each name their own call in parent, tool ID and
  `sourceToolAssistantUUID`, with matching literal file metadata and shared
  prompt identity. Current-prefix byte proof establishes the call/API layout;
  global call membership cannot authorize an old parent. Each result commits as
  its ordinary tool update. A private checkpoint after the first requires the
  second as the next physical record and remains pending at EOF. Full second
  result commit restores ordinary chaining through final/resumed answers.
  Existing projection-4 progress and Event/Raw keys remain stable, and repeated
  assistant usage updates one API identity at its latest revision.
- Native root automatic Read-turn compaction on Claude Code 2.1.263: exact
  [user U, reminder G, text plan P, Read C, result R, reminder A], or its
  successful ordered two-Read variant with C0/C1/R0/R1. The source copies all
  six/eight records, while retained metadata names only P through A. Current
  committed-prefix proof checks every original and complete copy, including
  unknown fields; each copy adds only the first common slug. All copies plus
  new boundary/summary commit together Raw-only, adding no Events or usage.
  The existing pending-answer checkpoint requires the real first text answer;
  later text blocks/resumes use ordinary chaining and latest API usage. Only
  one first-slug round per native tool layout was sampled.
- Native manual root Read file reinjection on Claude Code 2.1.263: the selected
  text-plan/two-Read turn ends in two final text records, and manual compact
  preserves only that final pair. After summary/command/stdout controls, file B
  then file A exactly reproduce the entire corresponding successful receipt
  objects; original input, receipt path and filename match literally. Current
  source-prefix proof binds the adjacent original turn and every control to the
  selected root. Both files commit together Raw-only and keep compaction in
  resume, allowing compact EOF before the next process. Its internal Meta Continue
  and adjacent zero-token synthetic bridge form a second Raw-only group, proved
  against the already committed pair. Neither first slot can ACK alone; the
  file branch cannot skip or duplicate Meta. Old no-file direct stdout bridges
  remain supported through actual-leaf proof. Real subsequent turns retain the
  existing root, Event/usage/Raw identities and projection-4 cursor schema.

## Explicit limits

No tool-parent batches beyond the exact ordered successful two-Read layouts,
automatic compaction beyond the exact text/Read-turn replay groups, cross-file continuation,
manual tails outside the singleton or exact two-record text shapes, arbitrary
copied UUID replay, child compaction,
branching/rewind, background or nested subagents,
interrupted child runs, child forks or spill collection in this increment.
Foreground parentage is fixed before publication; there is no implicit reparenting
or atomic family replacement. Ambiguous graphs, changed committed prefixes,
corrupt checkpoints and JSONL records exceeding 16 MiB are isolated explicitly.
Root pages are drained first; sustained root backlog can delay child capture.
Admitted children rotate between pages once the root is caught up.
Whole Session size and total record count are no longer limited to 4 MiB / 10,000.
Each observation honors the Host's 500-event / 3 MiB Canonical budget and 16 MiB
Raw budget. Root/child Thread headers, including each newly admitted child, are
reserved before filling Canonical pages. Text fragments are at most 256 KiB; smaller requested budgets fail
explicitly if one record or fragment cannot fit. Prefix hashing detects edits to
already captured bytes; a changed file requires streaming those bytes again for
integrity, while parsing and publication resume at the saved record position.
Each newly encountered two-record manual boundary adds one streaming proof pass
over the committed prefix with bounded memory; the source is not an atomic
snapshot against concurrent rewrites.
Automatic text proof caps each retained/control record at 64 KiB, its group and
retained tail at 256 KiB each, and decoded tail at 16 physical records. These are
profile admission policies. A first copy is classified by normal complete-line
parsing before its 64 KiB admission check; an unclassified first partial line
still uses the ordinary 16 MiB scanner. Later control slots use bounded lookahead;
the real answer keeps ordinary record/fragment limits. Each encountered complete
candidate can require an O(committed prefix) proof pass even while later slots
are unfinished. Retained proof memory is bounded, not total verification I/O.
A usage item that cannot fit a fresh page's reserved Canonical capacity reports
a source limit; remaining-space exhaustion defers it normally. Increasing the
capacity resumes pending usage/Raw without replaying an acknowledged Event.
Read-pair proof retains a 256 KiB byte tail and decodes at most three physically
adjacent call/plan records, each at most 64 KiB including LF. The private saved
file path is nonempty, NUL-free and at most 64 KiB of UTF-8. These are Adapter
policy limits. Receipts keep ordinary 16 MiB parsing and per-record source/Event
budgets, without requiring both to fit together. Proof costs O(committed prefix)
I/O/hash; large tool results retain the existing bounded-detail/Raw policy.
Reversed, failed, async, interleaved, child or other-tool batches are outside
the profile. No atomic snapshot or general old-call parent permission is supplied.
Read-turn automatic proof retains at most eight adjacent originals in a separate
512 KiB byte tail. Originals/copies/controls each fit 64 KiB including LF; the
eight/ten-record group has a 640 KiB total cap (eight records imply at most
512 KiB). The whole group must fit fresh requested source capacity; remaining
space exhaustion defers it. Ordinary 16 MiB Read admission does not imply its
larger result fits this replay witness policy. Existing-slug/repeated tool rounds,
no-plan layouts and other/more/error/async results need further profiles. Text
replay retains its separate 256 KiB policies and repeated scope.
Manual Read reinjection selects only one first-slug text-plan/exact-two-successful
Read turn, its final text pair and reverse-order two-file chain. Each selected
original/control/file/bridge frame fits 64 KiB including LF, and each file-pair or
Meta/bridge group fits 128 KiB. The current-prefix pass retains ten bounded
original frames and five control frames; oversized unrelated earlier records
fall out of the ring. Both groups must fit fresh source capacity even with Raw
off; remaining-space exhaustion defers them whole. An unknown first partial
line keeps ordinary 16 MiB scanning; recognized admission and subsequent slots
use the smaller profile cap. No-file manual profiles retain ordinary limits.
Single/no-plan/other/error/async tools, more files, changed/repeated reinjection,
children and broader manual/automatic composition remain unsupported. The Adapter
uses complete stored receipt equality, including unknown values; it never opens
referenced files or normalizes literal paths to supply evidence.
Active compaction checkpoints require zero partial Event progress. A damaged
nonzero Event skip is rejected at EOF, partial input and blank lines; compaction
control records cannot supply a legitimate pending Event.
All current-prefix proofs cost O(committed prefix) I/O/hash with bounded memory.
Discovery scans at most 10,000 directory entries. Metadata-only cursors are
compressed above 16,000 bytes, with a 1 MiB wire / 16 MiB expanded bound. Capacity
errors retain committed progress. Only sources with readable identity
and original CWD in their bounded header are automatically attributable; use the
single-file override to diagnose malformed or unrecognized headers. An unsupported
attributed source is isolated without marking it captured; other sources continue.
Multiple files claiming the same Session identity are all isolated rather than merged.

## Partial collection

Automatic discovery reports source read/format errors, unsupported histories,
changed prefixes, oversized records and duplicate identities as local
`sourceFailures`. Unattributable headers are diagnosed locally; unrelated bodies
are not uploaded. Healthy Sessions still advance; failed Sessions retain their
committed progress and are retried next cycle. Repair a malformed source or restore
its exact captured prefix to resume it. Unsupported history needs a future Adapter
capability, not a cursor reset. No automatic deletion or permanent quarantine occurs.

Project → Sync details includes the diagnostics for partial
collection. Text output lists escaped source paths and generic reasons; the Host
masks configured secrets. Project status shows `partial` and continues
collecting. Reports retain up to 32 distinct diagnostics with a truncation flag,
not an exact count of all failed files. A clean cycle clears previous diagnostics.
Global discovery/cursor capacity, corrupt checkpoints and Host/transport failures
still fail the job. The single-file override stays fail-fast except that unknown
Git attribution is reported as partial coverage. Update the Host and
Adapter together to retain the new optional diagnostic fields.

An unsupported appended record can stop parsing before Raw backfill of an older
eligible prefix. Previously delivered receipts remain valid; supporting the new
shape or restoring its exact captured prefix allows collection to resume.
Enabling Raw does not bypass an unsupported tail.

The legacy Host's source-mutation/concurrent-writer and lost-checkpoint
recovery limitations still apply. Use a single Collector and preserve its state.
No new SQLite journal or provider-specific page is installed. Bounded shared tool
details ship under ADR-0030; full ACP content, generation tokens and atomic
publication remain deferred.

Supported compaction is additive, not complete Active Path replacement. Its
boundary, summary and controls are captured only when Raw is enabled; no
ordinary user/assistant Event is fabricated for them. Filtering applies only
inside the admitted native state machine, and ordinary records outside it retain
their existing projection. The compaction model response has no assistant record
in the native JSONL, so that request's actual token usage cannot be recovered.
`compactMetadata` counts are context bookkeeping, not usage; synthetic zero
counters do not create a usage item. Recorded real assistant usage continues
normally. A future replacement profile requires explicit legacy migration;
changing the manifest or clearing a cursor would not preserve capture.

## Upgrade order

Deploy the updated server (including migration 000010) before the updated CLI and
Adapter. The CLI emits `atape.acp-centered.v2`; the server still accepts v1
without tool details. Preserve Collector state. Supported checkpoint upgrades
retain root Event IDs and verify committed source prefixes; they do not invent
new Sessions. Projection revision 4 reprojects earlier supported root checkpoints
once to discover foreground receipts. Finish pending
old-client collection retries before upgrading other Adapters; this slice does
not add a general cross-profile recovery protocol. No package is published by
the development build commands above.

A package-version change alone no longer blocks recovery: the installed Adapter
decodes the persisted cursor schema and revalidates captured bytes. Unknown cursor
formats and changed prefixes still stop/diagnose the affected capture, never reset
it. Preserve the complete CLI state directory, upgrade through Tools and updates,
and inspect Project → Sync details afterward. This is not a promise of old Claude
source-format compatibility; a future breaking cursor format must provide its own
explicit migration or rejection. See [ADR-0032](../../docs/architecture/adr/0032-claude-release-and-recovery.md).

`fixtures/native-read-2.1.263.jsonl` retains decoded records from a real, controlled
Claude Code 2.1.263 invocation, with home/temporary paths substituted. It is not
byte-identical original Raw and contains only synthetic prompt/tool content.
Tests invoke this production Adapter, not a separate model of its behavior.
Additional native source records use deterministic loopback model responses,
synthetic content and actual native source persistence:

- [Foreground child](fixtures/native-foreground-child-2.1.263/README.md): one
  completed direct Agent/Read family with separate root/child Raw streams.
- [Manual compaction](fixtures/native-manual-compact-2.1.263/README.md): retained
  singleton tail, Raw-only controls and real continuation.
- [Manual text tail](fixtures/native-manual-text-tail-2.1.263/README.md): two
  same-response text records and two continuations. Text mentions Read, but no
  Read operation was executed in this run.
- [Automatic text replay](fixtures/native-auto-text-replay-rounds-2.1.263/README.md):
  five native snapshots with three automatic rounds and exact copied U/G.
- [Two Read results](fixtures/native-read-pair-2.1.263/README.md): two independent
  response layouts, actual synthetic-file Read operations and own-call parents.
  The older text-plan case does not establish a fresh HOME.
- [Read-turn automatic replay](fixtures/native-auto-read-replay-2.1.263/README.md):
  ten snapshots in two independent Sessions with six/eight exact first-slug
  copies and later real answers/resumes. Single executes only Read a.txt;
  inherited HOME was not recorded in either case.
- [Manual Read file reinjection](fixtures/native-manual-read-reinjection-2.1.263/README.md):
  six native snapshots with two actual successful Reads, retained final text pair,
  reverse-order file reinjection, internal Meta/synthetic bridge and two real
  continuations. Entire reinjected content objects equal the original receipts.
  Config/workspace were isolated; inherited HOME was not recorded. Derived cuts
  are append boundaries, not additional native captures.

Mock usage counters establish projection/deduplication, not billing. Compaction
responses have no assistant JSONL usage, so their actual usage remains unavailable.
The [current Claude guide](../../docs/adapters/claude.md#verification-and-remaining-work)
owns implementation checks, integration evidence and remaining limits. The
corresponding ADRs record decisions rather than delivery status. Source fixtures
alone do not establish package publication, deployment, browser staging or
upgrades from historical published binaries.

For a local development build, install `./adapters/claude` through Integration maintenance before choosing tools.
