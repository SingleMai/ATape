# Claude Code Adapter

The Claude Adapter discovers Project-scoped JSONL history and delivers it through
ATape's paged Collector. The Host owns attribution, redaction, Canonical/Raw
uploads and checkpoints. Claude uses the legacy batch write mode; it does not
use OpenCode's atomic publication or SQLite capture journal.

## Install and enable

Use **Tools and updates** to add Claude to the existing global tool selection,
reviewing its effect on all connected Projects. Package installation alone does
not authorize capture. See the [package README](../../adapters/claude/README.md)
for local build/install commands and the [CLI guide](../cli/setup-and-adapters.md)
for Project setup and tool management.

## Sources and supported history

Discovery reads `~/.claude/projects/*/*.jsonl`. `ATAPE_CLAUDE_HOME` selects an
absolute alternate configuration directory; `ATAPE_CLAUDE_SESSION_FILE` selects
an absolute single root file for diagnostics. Symlinks are not traversed. Child
files are read only through the foreground relationship described below; other
subagent directories are not recursively scanned. The first UUID record's
original CWD establishes attribution;
directory names and later directory changes do not reassign a Session.

Git Projects use shared Host attribution across worktrees and independent clones.
Foreign repositories are excluded; missing original directories without retained
evidence produce an attribution diagnostic. Both CLI and Adapter require
`atape.git-attribution.v1`. Ordinary-directory matching remains path-scoped.

Root and admitted foreground child streams use append-only UTF-8 JSONL. Ordinary
records form a strict linear chain; the root also admits the narrow native Read
result and manual/automatic compaction profiles below:

- User/assistant text and bounded tool calls/results, including escaped Input/Output
  details in the common reader. [Search](../api/project-search.md) matches user and
  assistant message bodies; tool summaries and full tool values are excluded.
- Stable record UUID and physical block-slot Event identities, with per-Session
  incremental progress and one changed Session per page.
- Complete-line parsing, bounded text fragments and appendable Raw objects.
  Source deletion retains captured history and checkpoints.
- Source failure isolation: healthy Sessions continue; failed Sessions retain
  progress and are retried. Duplicate identities are isolated rather than merged.

Conversation records require a valid UUID and matching Thread identity before
projecting either Events or usage. UUID-less native bookkeeping remains Raw-only;
it cannot create a turn or an assistant usage record.

Tool batches and compaction beyond the sampled profiles, cross-file continuation, child compaction, branching/rewind,
background or nested subagents and spill collection remain outside the supported
profiles. Unknown content and nonempty thinking remain Raw when captured;
tool-bearing projections retain partial fidelity. The retained controlled native
fixture comes from Claude Code 2.1.263; it is not a blanket compatibility promise
for every Claude version or history shape.

## Foreground subagents

[ADR-0087](../architecture/adr/0087-claude-foreground-subagents.md) selects ordinary
completed foreground children without changing legacy write mode. A root `Agent`
or `Task` result must declare `toolUseResult.status: "completed"` and `agentId`,
be non-asynchronous and non-error, and match the tool invocation through its
tool-use ID and exact `sourceToolAssistantUUID`. The selected source is
`<root-file-directory>/<sessionId>/subagents/agent-<agentId>.jsonl`. Its first UUID
record must share the root's Session ID and original CWD, declare the selected
Agent ID and `isSidechain: true`. Merely finding a file in that directory does
not authorize collection. The `.meta.json` sidecar is not read for capture.

The root's original Project attribution applies to the proved child. Each child
becomes a `claude-agent:<agentId>` Thread under `root`, linked from the actual
parent tool result in the reader. Child CWD changes do not reassign the Session.
Root Event and Raw identities are preserved. Each child has independent prefix,
Canonical and Raw progress, so its pages can resume without replaying acknowledged
root content. Existing version-1 single-file and version-2 discovery cursors remain
supported; version 2 gains optional `children` checkpoints, child traversal and
family revision/time metadata without discarding old progress. Projection
revision 4 reprojects older supported root checkpoints once to find their
foreground receipts, retaining Event IDs and verifying committed prefixes.

This additive profile does not supply atomic family replacement or change a
published child's parent. Unproved, malformed or unsupported child histories
produce local diagnostics without blocking other attributable sources. Missing
children retain acknowledged progress without a new failure; a child that has
never been captured remains a missing-source diagnostic. Nested/background delegation,
interrupted child runs, child forks, child compaction and rewind require further native
profiles and are not enabled by accepting ordinary foreground evidence.
Root pages are drained before child pages; a sustained root backlog can delay
child capture. Admitted children rotate between pages once the root is caught up.

## Two Read results from one response

[ADR-0090](../architecture/adr/0090-claude-read-pair-result-parents.md) selects two
native Claude Code 2.1.263 root layouts: adjacent `Read@0, Read@1` calls, or one
`text@0` followed by `Read@1, Read@2`. Each physical record has one content block;
all members share one real assistant API ID/model/role and `tool_use` stop reason.
The second call is parented by the first, and the optional text plan must be the immediately
preceding record with a direct parent edge to the first call.

The following two successful results arrive in call order. Each native user
record has one `tool_result`; its parent and `sourceToolAssistantUUID` both name
its own call, and its tool ID matches that call. These parents differ from the
preceding physical record. The result must have the sampled text/file metadata
and a literal file path equal to the Read input. Both results share a prompt ID.
File line counters are positive safe integers and the returned range fits
`totalLines`; zero-line or malformed metadata is outside this profile.
`is_error` and known async/Agent/status markers are absent in this profile.
Selected Session/CWD, root ownership and native control omissions must agree.
The Adapter does not read the referenced files or regenerate their output.

Before admitting the first result, a bounded tail of the currently committed
source bytes proves the calls and optional plan. It is decoded from the same
bytes that establish the current prefix hash, including calls fully committed
earlier on that page. Existing call-map membership alone cannot authorize an old
parent. An Event-only call whose usage or bytes remain pending is not in the proof.

The first result commits as its ordinary single `tool_call_update`, then ends
the page with a private `readPair` checkpoint requiring the second result as the
next physical record. EOF remains one pending Canonical Session without a busy
continuation loop. A partial second result waits; any complete intervening
record is unsupported and preserves acknowledged progress. The second result
clears the state only when its full record commits, then ordinary chaining
continues through the final answer and resumed conversation. EOF after the calls
alone does not invent a pending result.

Each receipt keeps ordinary per-record budgets; the two receipts need not fit in
one page. Raw receipts can advance independently through admitted bytes while
the Host retains an older parser cursor, and retries prove the same calls again.
Existing projection-4 checkpoints, physical block-slot Event IDs, tool
associations and Raw identity/generation are preserved. Split call records
update one API usage identity at its latest revision rather than summing counters.
Large result values follow the existing bounded tool-details policy; results do
not become user messages or fabricated text fragments. Their exact Event anchors
remain available in Reader; Search covers actual conversation text.

This profile does not admit more calls, reversed/interleaved/error/async results,
other tools, child batches or tool-bearing compaction. It does not grant general
parent exceptions to historical calls or globally change the older linear profile.

## Manual root compaction

[ADR-0088](../architecture/adr/0088-claude-manual-compaction-on-legacy-capture.md)
selects one additive `/compact` profile from native Claude Code 2.1.263. It keeps
the original source prefix and pre-compaction conversation, then appends real
continuation turns to the existing root Thread. It does not replace the Active
Path or migrate legacy capture to source publication.

Admission requires a root `compact_boundary` with `trigger: "manual"`, a null
physical parent and `logicalParentUuid` equal to that stream's current last UUID.
The retained tail must be either that single UUID or exactly two physically
adjacent root assistant records from the same API response. For a pair, each
record contains one nonempty text block; API block indices are 0 and 1, models
and assistant roles match, and the second record is parented by the first. The
tail is the current last UUID. The segment endpoints and both preserved UUID
arrays must match the selected tail in order; the preserved anchors must select
the immediately following summary.
That summary must be a user-shaped native record parented by the boundary with
`isCompactSummary` and `isVisibleInTranscriptOnly` both true. The supported chain
then contains the native local-command caveat, `/compact` command, command stdout
and zero-token `<synthetic>` `No response requested.` assistant bridge. Every
UUID edge and control marker must match the admitted profile. Missing records
can wait for later appends; conflicting records produce a source diagnostic.

Inside this proved chain, the boundary, summary, command controls and synthetic
bridge remain Raw-only, subject to the user's Raw policy. The internal summary
is loaded into the next model request; it is kept out of Canonical because it is
provider-generated context rather than a new user message. It does not appear as
a user turn or Search result, and the bridge is not a real assistant response.
Records outside the admitted state machine retain their existing projection; an
unbound compact summary is unsupported.

An optional versioned compaction stage lives in the existing stream checkpoint.
Its expected UUID and phase advance with the prefix hash, byte offset and record
order only after a complete record is accepted. A bounded page can stop at the
boundary, summary or command controls, recreate the runtime and continue without
forgetting the required next record. Supported old cursors remain valid and
projection revision 4 is retained. Existing Session, Thread, Event and Raw keys
remain stable; no old Canonical Event is withdrawn or reassigned.

The two-record shape is proved by streaming the currently committed prefix
through the same open source handle and hashing those exact bytes while retaining
only the last two UUID-record proofs and their physical positions. This includes
records newly committed on the current page. It does not replay old Events or
usage, or require new cursor fields. A fragmented record joins the committed
prefix only after its Events and usage fit. Bookkeeping after the pair is allowed;
any intervening physical record between its two members breaks adjacency.
The proof adds one streaming pass over the committed prefix at each new
two-record boundary. It retains existing concurrent-writer limitations and does
not establish an atomic file snapshot.

Token completeness has a source limit: this native compact request has no
assistant response record in JSONL, so its actual model usage cannot be recovered.
`compactMetadata` token counts are context bookkeeping and are not converted to
assistant usage. Only real recorded assistant responses contribute usage; the
synthetic bridge's zero counters do not create a usage item. The profile does not
enable tails outside these two manual shapes or the separate automatic profile
below, cross-file continuation, child compaction, rewind or forks.

## Automatic root text compaction

[ADR-0089](../architecture/adr/0089-claude-automatic-text-replay-on-legacy-capture.md)
selects a separate append-only Claude Code 2.1.263 text profile. Each round retains
the current [A,U,G]: one real single-text assistant response A at API block index
0, ordinary user U and its token-reminder attachment G, with direct A → U → G
parents and physically adjacent U/G. The source then copies U/G and appends a new
automatic boundary B and internal summary S. Both preserved UUID arrays and
segment endpoints must name exactly that current tail; logical parent is G and
both anchors select S. S is parented by B and retains U's prompt identity.

The copies must preserve every decoded original value, including unknown fields.
The first sampled round adds only a common slug when A/U/G all lack one; later
rounds preserve the same existing slug exactly. Mixed slug presence, changing an
existing slug, altered copies, stale tails or reused B/S identities are
unsupported. A bounded tail reconstructed from the same bytes as the current
prefix hash proves originals, including records committed earlier on the page.
Seen UUID membership alone cannot authorize a copied record.
The first committed UUID record must also match the attributed original root
identity, including CWD; changing it between attribution and collection fails.

Copies U/G and new B/S commit as one four-record Raw-only group. An incomplete
group waits before its first copy without advancing eligible source progress;
an invalid complete slot produces a source failure. The group must fit a fresh
source-page budget; insufficient remaining capacity defers the whole group.
Once committed, the page ends and an optional private `autoText` checkpoint
requires the next real single-text assistant answer, parented by S with the
admitted slug. It remains pending through text fragments and deferred usage,
and clears only when the full answer record commits. Missing answers can wait;
another group or conflicting control cannot replace the required answer.

Every later round proves a fresh current tail and new B/S. Three native rounds
were sampled; no round counter or forced replay is needed. Supported old cursors,
projection revision 4, pre-compaction conversation and Session/Thread/Event/Raw
identities remain stable. Each original U appears once in Reader/Search. Copies,
boundaries and summaries add no Events or usage. Only actual recorded assistant
answers append; summary-call usage is absent from this JSONL, as in the manual
profile. Ordinary tool batches, copied assistants, wider retained layouts,
child compaction and Active Path replacement are outside this automatic profile.

## Automatic root Read-turn compaction

[ADR-0091](../architecture/adr/0091-claude-read-turn-automatic-replay.md) selects
two additional native Claude Code 2.1.263 root layouts. A single successful Read
has current original records [U,G,P,C,R,A]; the exact-two Read has
[U,G,P,C0,C1,R0,R1,A]. U is an external user, G its token reminder, P a single
text plan at API index 0, C/C0/C1 the same response's Read calls at indices 1 or
1/2, R/R0/R1 their successful own-call results, and A a final token reminder.
All six/eight records are physically adjacent and fully committed. Each result
matches its literal call path, tool ID, parent/source assistant UUID and U's
prompt. Both reminders have their exact native parent edges. A pending Read-pair
result cannot authorize replay before it completes.

The source copies all six/eight records, then appends B/S. Its retained metadata
names only the four/six records from P through A: U/G are copied but excluded
from those arrays. Segment endpoints are P/A, logical parent is A, and both
anchors name the new summary S. Every original omits slug; each copy adds only
the same first slug and must otherwise equal the complete decoded original,
including unknown values, API usage, tool input/output and parent edges.
An authenticated tail of the exact current committed prefix proves this graph;
global seen/call membership merely helps select the profile.

The six/eight copies plus B/S commit as one eight/ten-record Raw-only group.
Incomplete groups wait before the first copy, conflicting complete records fail,
and requested source capacity must fit the whole group. Copies do not emit
Events or usage revisions. The existing private `autoText` state then requires
the first real text answer at index 0, parent S and admitted slug. Full commit
clears it; the native second text record follows ordinary chaining and updates
the same API usage identity. Missing answers stay pending without busy retries.
Old projection-4 checkpoints and independent Raw receipts retain their existing
recovery, Event identities and complete physical source bytes.

Each sampled tool case has one first-slug automatic round followed by two
ordinary resumes. Existing-slug tool replay, repeated tool rounds, tool-only
layouts without P, other/more/error/async/interleaved calls, children, manual
tool compaction, file reinjection and Active Path replacement remain outside
this profile. The separate text profile retains its proved repeated-slug scope.

## Bounds and Raw policy

The [package README](../../adapters/claude/README.md#explicit-limits) owns detailed
source/cursor ceilings: 16 MiB records, 256 KiB text fragments, bounded discovery
and compressed metadata cursors. Large total archives stream across pages;
changed files still require hashing previously captured bytes to verify prefixes.
Smaller Host budgets may reject a record or fragment that cannot fit.
Automatic text proof admits at most 64 KiB per witness/control record, a 256 KiB
group and retained byte tail, and 16 decoded tail records. These are Adapter
policy limits, not native format limits. A complete first copy is classified by
ordinary parsing before its smaller admission limit applies; an unclassified
first partial line retains the ordinary 16 MiB scan limit. The remaining three
slots use bounded lookahead. Real answers keep ordinary text limits. Proof
rereads the committed prefix when a complete replay candidate is encountered;
retained memory is bounded, but verification I/O is O(committed prefix). The
existing concurrent-writer limitations still apply; no atomic snapshot is supplied.
Read-pair proof admits at most three physical witness records, each at most
64 KiB including LF, from a 256 KiB retained byte tail. The saved literal file
path is nonempty, NUL-free and at most 64 KiB of UTF-8. These are Adapter profile
and cursor policies, not native format limits. Result records retain ordinary
16 MiB parsing and requested source-page admission. Proof costs O(committed
prefix) I/O/hash with bounded retained memory; it does not add snapshot semantics.
Read-turn automatic proof has separate limits: at most eight physical original
records from a 512 KiB retained byte tail, at most 64 KiB including LF per
original/copy/control record, and a 640 KiB group. The single layout's eight
group records additionally imply at most 512 KiB. These are Adapter policies;
ordinary Read receipts can fit the 16 MiB parser yet exceed this smaller replay
witness limit. Large irrelevant earlier history and real answers keep ordinary
fragmentation rules. The existing text proof's 256 KiB policies are unchanged.
Both groups must fit the fresh requested source-page capacity even with Raw off;
remaining-space exhaustion defers the whole group. Proof still costs
O(committed prefix) I/O/hash and does not create an atomic filesystem snapshot.
A real usage item that exceeds a fresh page's reserved Canonical capacity fails
with a source limit. Insufficient remaining space defers it to the next page;
it does not leave an impossible item waiting indefinitely. Retrying with enough
capacity preserves any already acknowledged Event and resumes its usage/Raw.
Canonical pagination reserves the encoded root/child Thread headers before
adding Events or usage, including a newly admitted child's header. Wide families
therefore retain the requested page bound for both root and child text pages.

The Adapter declares `atape.raw-capture.v1`. With Raw disabled, Canonical continues
without advancing Raw upload receipts. Re-enabling Raw backfills retained source
bytes under the [current capture policy](../cli/raw-capture.md). Unsupported or
oversized tool values remain available only if Raw was actually captured.

## Recovery and upgrades

Inspect Project → Sync details in ATape for partial collection.
Source diagnostics are bounded, redacted and local; they do not assert that all
failed files have been enumerated. Repair malformed data or restore the exact
captured prefix to resume. Unsupported history needs an Adapter capability;
resetting a cursor does not make it supported.

Preserve the full CLI state directory. A package-version change alone does not
reset progress: the Adapter checks cursor schema and captured-prefix integrity.
Unknown formats or changed prefixes fail explicitly. Package replacement tests
prove recovery mechanics using re-versioned current bundles, not compatibility
with every historical binary.

The receiving Server must accept `atape.acp-centered.v2` before a CLI emitting
bounded tool details is used. Existing v1 requests remain accepted without tool
details. Use the coordinated release and [release guide](../releasing.md);
package publication and Server deployment are separate actions.

## Verification and remaining work

Relevant checks are Adapter tests, `pnpm test:e2e`, `pnpm test:adapter-package`
and `pnpm test:release`. They cover production discovery/projection, shared tool
redaction, large-archive pagination, source failure isolation and installed-package
replacement. They use controlled data, not personal history.

Wider Claude history support and
changes to prefix-verification cost require their own compatibility evidence;
no cursor reset, alternate uploader or implicit source migration is promised.

The [foreground fixture record](../../adapters/claude/fixtures/native-foreground-child-2.1.263/README.md)
was captured on 2026-10-08 from the installed Claude Code 2.1.263 using an isolated
configuration and deterministic loopback Anthropic SSE mock. Claude produced the
Agent identity, parent receipts, sidechain records and actual Read result; model
text, IDs and usage were controlled. No personal conversation or live model was
used. This establishes one completed direct foreground Agent with Read, not
nested/background execution, resumed children or other versions. The Adapter
also recognizes the legacy `Task` tool name; this corpus samples `Agent`.

The [manual-compaction fixture record](../../adapters/claude/fixtures/native-manual-compact-2.1.263/README.md)
records a separate native Claude Code 2.1.263 run on 2026-10-08 with isolated
configuration and the deterministic loopback model mock. Its before, compacted
and continued snapshots retain the same byte prefix, with one preserved tail
UUID, no replayed UUIDs and a real continuation request that loads the summary.
The corpus contains three real assistant usage records and one zero-token native
synthetic bridge; the compaction response itself is absent from JSONL.

The [two-record text-tail fixture record](../../adapters/claude/fixtures/native-manual-text-tail-2.1.263/README.md)
adds four native snapshots from another isolated Claude Code 2.1.263 run on the
same date. It preserves two text records from one API response without UUID
replay, then appends two real continuation turns. Those two records share an
API usage ID: their latest usage revision counts once even across pages. The
corpus expects 11 Events and five distinct real usage records totaling 151 input
and 73 output tokens. Its text mentions Read results, but no Read call was
executed in this run; it establishes the text-tail shape only. The compact
response itself again has no assistant JSONL usage record.

The foreground and singleton-manual increment was integrated through
[PR #188](https://github.com/SingleMai/ATape/pull/188) after its final-commit CI
and Security gates passed. Its local Claude typecheck, 96 Adapter behavior
tests and installed Claude `verify:package` passed. The regression exercised
100 Threads with near-3 MiB root and child text, bounded Canonical pages, stable
retry, 619 unique Events and 100 complete independent Raw objects. The four
Collector/Server E2E tests and CLI typecheck passed; architecture and documentation
guards also passed. Adapter checks cover old checkpoints, Raw off/on, unfinished
compaction stages, malformed controls, unsafe family paths and conflicting
ownership without resetting acknowledged progress.
Malformed conversation UUIDs and mismatched root/child identity are rejected
before Events or usage, while native UUID-less bookkeeping stays Raw-only.

The installed package and shared Collector/Go HTTP path captured the foreground
family as eight Events, four assistant usage records totaling 68 input and 36
output tokens, and two Raw streams. Manual before/compacted/continued capture
retained six Events and three real usage records totaling 81 input and 37 output
tokens; the compacted stage added zero Events and usage. Bounded package pages
recreated the runtime, retained old Event and Raw identities, retried without
duplicates and captured every retained source byte, including controls.

`pnpm test:claude-contract` additionally passed the required named contract on
real Docker/PostgreSQL and authenticated HTTP using installed CLI/Claude
tarballs and an actual managed daemon restarted at each source stage. It verified
Project attribution, root-to-child Reader navigation, exact Search Thread/anchor,
the same usage totals, stable Raw object/generation, paged Raw byte continuity,
unchanged polling, shared Canonical/Raw redaction, Raw off/on backfill, unsupported
append isolation, exact-source repair and history retention after source deletion.
Summary, command and synthetic bridge text stayed outside Canonical/Search.
Legacy Reader Sessions still use complete reads; this contract does not establish
publication-head pagination. The combined PostgreSQL CI guard now requires the
Claude subtest itself to pass, rejecting missing or skipped results.

The two-record text-tail increment was integrated through
[PR #189](https://github.com/SingleMai/ATape/pull/189) after final-commit CI and all
Security gates passed. It additionally passed Claude typecheck and all
136 Adapter tests, including 40 new public-Interface cases. Installed Claude
`verify:package`, CLI typecheck, the four Collector/Server E2E tests, documentation
and architecture guards passed. Checks cover one-Event pages with a fresh runtime
and identical unacknowledged retries, 600,000-character text records fragmented
across pages, usage deferred after its Event, long-lived prefix-hash caching,
incomplete appends, Raw off/on and unsupported-tail isolation. A separate public
Interface check generated an acknowledged projection-4 checkpoint with the
previous merged Adapter Implementation, then resumed compact and both
continuations with only four new Events and unchanged old identities.
The additional budget regressions cover impossible usage capacity with Raw on
and off, and an acknowledged Event whose pending usage resumes without replay
after a too-small page is rejected.

The extended installed-daemon PostgreSQL contract passed 14 independently
restarted source stages while retaining the original foreground and singleton
checks. It first captures the split response head from a complete native byte
prefix, then appends the tail in a later daemon run. Reader grows from six to
seven Events while PostgreSQL Overview retains three usage IDs and 93/47 tokens,
proving the shared API usage is updated once across separate HTTP deliveries.
The compact stage adds no Events or usage; two continuations finish at 11 Events,
five usage IDs and 151/73 tokens. Exact Search anchors, stable Raw object and
generation, complete paged Raw bytes, unchanged polling, policy recovery and
history after source deletion passed. The prefix cut is a test append boundary,
not another native snapshot.

The [automatic text replay fixture](../../adapters/claude/fixtures/native-auto-text-replay-rounds-2.1.263/README.md)
retains five native invocation snapshots: seed, warmup and three resumed
automatic rounds. First-round copies add only the slug; later copies retain it
and are also byte-identical to their originals after declared path substitution.
Each round selects the current three-record tail and new boundary/summary.
Selected model-message evidence shows each new summary entering context once.
The loopback mock's artificial 190000-token input counters and 20-percent trigger
setting force the workflows; they do not establish real tokenization or billing.
All three summary responses lack persisted assistant JSONL usage.

The automatic text increment was integrated through
[PR #190](https://github.com/SingleMai/ATape/pull/190) after its final-commit CI
and all Security gates passed.

Claude typecheck and all 230 Adapter tests passed, including 94 automatic-profile
public Interface cases. They cover current-tail/slug/unknown-field conflicts,
reused anchors, seven incomplete group cuts, source and tail capacity, answer
fragments and usage deferral, invalid/child checkpoints and prefix rewrites.
An iterative JSON comparison accepts equal 4000-level unknown fields within the
record byte cap and rejects changed deep values without exhausting the call
stack. Raw receipt recovery also retains an old parser cursor while upload
receipts independently advance into the proved group. Original-CWD mutation
between attribution and collection is rejected without new Canonical/Raw data.
CLI typecheck, Go HTTP compile, documentation and architecture guards passed.

Local installed Claude `verify:package` and the four Collector/Server E2E tests
passed for automatic text replay. Package checks use one-Event pages, recreated
runtimes and exact unacknowledged retries through all five native snapshots,
partial first copies, complete one/two/three-slot groups, pending summaries and
real answers. Derived cuts are source prefixes, not extra native snapshots.
An independent public Interface check used the previously merged Adapter at
`b43c952dc7b60555ed242c590089d2d999f5f09b` to acknowledge the first original G,
then resumed with this Implementation: five old Events remained and only five
new Events completed all three rounds, with one complete stable Raw object.

The extended installed-daemon contract passed 32 independently restarted source
stages on authenticated HTTP and real Docker/PostgreSQL, retaining the foreground, both manual-tail, policy/redaction,
unsupported-source repair and deletion checks. Each automatic round captures
original U/G, polls unchanged, admits the Raw-only group through S, restarts and
polls with one pending Canonical Session, then captures the real answer and
returns to zero pending. Reader grows from four to six, eight and ten unique
Events while usage grows from two to three, four and five API IDs, ending at
760023 input / 63 output. Copies and summaries add no Events or usage; Session
metadata can still produce Canonical batches. Old Reader prefixes, exact Search
anchors, stable Raw object/generation and all physical source bytes passed.
The required non-skipped Claude contract guard also passed.

The [two-Read fixture](../../adapters/claude/fixtures/native-read-pair-2.1.263/README.md)
retains four actual native snapshots in two independent Sessions. The tool-only
case uses a recorded fresh HOME/config/workspace; the older text-plan case proves
isolated config/workspace but does not record fresh HOME. Both execute actual
Read on synthetic files. Captured model requests contain both results once;
native request assembly changes the second result's formatting, so Raw/request
byte equality is not claimed. These selected snapshots contain no compaction.
The tool-only resume ends at eight Events, three recorded API usage IDs and
101/31 mock counters; the text-plan toolturn ends at twelve Events, four IDs and
130/64. Ten test cuts are derived LF prefixes, not additional native runs.

An independent public Interface check used the previously merged Implementation
at `31cf92a68ac3a9a02a2fc2a2559ed23b1a3155f3` to acknowledge each layout through
its second call. This Implementation preserved the three/eight old Events and
appended only five/four new Events respectively. Every page recreated the runtime
and retried identical unacknowledged input. R0 EOF remained one pending Canonical
Session; full R1 commit returned to zero. Own-call updates, latest API usage and
complete contiguous Raw bytes retained one object/generation per Session.

The two-Read increment was integrated through
[PR #191](https://github.com/SingleMai/ATape/pull/191) after final-commit CI and all
Security gates passed. Claude typecheck and all 328 Adapter tests passed,
including 98 new public Interface cases. They cover both native layouts,
same-page and restarted proof, partial receipts, pending EOF, genuine C1
Event-only/usage-pending recovery, fresh/remaining source and Canonical budgets,
large result detail omission, independent Raw receipts with an older parser
cursor, Raw off/backfill, deep unknown fields and malformed recognized cursors.
Both first-result and pending-second checkpoints reject a nonzero result skip,
preventing a damaged cursor from silently dropping the sole tool update.
The final installed Claude `verify:package`, CLI typecheck, four Collector/Server
E2E tests, documentation and architecture guards passed.

The extended authenticated HTTP/Docker PostgreSQL contract passed 49 managed
daemon runs, retaining all 32 prior stages and adding 13 Read source phases plus
four unchanged polls. Each call/result and split final text arrives in a separate
process and HTTP delivery. Reader retains the old Event prefix, associates both
updates with their own Read calls and resolves both exact result anchors. R0's
unchanged restart remains pending with no upload; R1 completes it. API usage
upserts once across call/text revisions. Raw object/generation, exact paged bytes,
source diagnostics/repair, policy/redaction and history after deletion passed.
Message-body Search resolves native user/plan/final/resume anchors exactly once
and excludes tool summaries, IDs and full values. The required non-skipped Claude
contract guard passed.

The [Read-turn automatic fixture](../../adapters/claude/fixtures/native-auto-read-replay-2.1.263/README.md)
retains ten actual native snapshots in two independent Sessions: seed, warmup,
one automatic tool round and two ordinary resumes per case. All snapshots are
strict byte-prefix extensions under declared literal path substitution. Removing
only the newly added slug makes all six/eight copied lines byte-identical to
their originals. Metadata selects P through A, separately from copied U/G.
The single case executes only Read a.txt despite mock final prose mentioning
b.txt; the dual case executes both. Both record isolated config/workspace and
inherited, unrecorded HOME. Selected actual model requests load the exact summary
and each executed result once; the last result's request formatting is transformed.

Logical expectations end at fourteen/sixteen Events respectively, six persisted
API IDs each and 190151/90 mock counters. The summary response has no assistant
JSONL usage; its controlled 51/19 stdout difference is excluded. First answer
and second text block share one API usage identity. Derived LF cuts are test
append boundaries, not additional native invocations.

For the Read-turn automatic increment, Claude typecheck and all 483 Adapter
tests passed, including 155 new public Interface cases. They cover both native
layouts, fresh same-page proof, every incomplete group slot, exact retries and
runtime restarts, copy/control/current-original faults, genuine plan and F0
Event-only/usage-pending recovery, F0 fragmentation, independent Raw receipts,
Raw off/backfill, large irrelevant history and oversized required witnesses.
Deep 4000-level unknown values and object key reordering preserve complete
decoded equality; changed leaves, array ordering and negative zero are rejected.
Exact 640 KiB groups with 64 KiB LF-inclusive frames pass; an equally sized
incomplete final frame fails with a source limit. Old text-profile tests retain
their independent 256 KiB bounds. CLI typecheck, documentation and architecture
guards passed; all four Collector/Server E2E tests passed.

The final installed Claude `verify:package` passed all ten native snapshots
and 36 derived LF cuts, with one-Event pages, recreated runtimes and identical
unacknowledged retries. Unproved copies/B retain the original parser/Raw offset,
with pending Raw equal to unread physical bytes. Complete S captures the group
once and stays pending; full F0 clears it, F1 updates the same latest API usage.
Copied APIs keep their original source revision. Own-call updates, old Event
prefixes, one Raw object/generation and all physical source bytes passed.

Independent public Interface verification generated four actual opaque
checkpoints with the previous merged Implementation at
`60110ff0f7594240596f83bf53801e933daf9313`: single at C/A and dual at C1/A.
This Implementation preserved the seven/eight/eight/ten acknowledged Events,
then completed fourteen/sixteen unique Events respectively with six usage IDs
each. Raw receipt-only recovery kept the older A parser cursor and re-proved
the group without gaps. The 108 independent upgrade/fault/resource checks
passed. These are prior Git Implementation upgrades, not historical published
binary acceptance.

The extended authenticated HTTP/Docker PostgreSQL contract passed 73 independently
restarted managed-daemon runs, retaining all prior 49 and adding 24 Read-turn
automatic boundaries/idle polls. Original plans, calls and each result commit
separately; the final reminder and proved group add zero Events. S leaves one
pending Canonical Session; its idle restart sends nothing. F0 clears pending,
F0/F1 upsert one API usage identity, and both real resumes append two Events.
Old Reader prefixes, exact own-call result anchors, message-body Search anchors
and exclusion of copied/tool/internal controls passed. Each Session retains one
Raw object/generation with complete gap-free bytes, including all copies/B/S.
Prior redaction, policy recovery, unsupported-source repair and deletion checks
remain covered. The required non-skipped Claude contract guard passed.

Controlled counters establish projection and deduplication, not provider billing.
CLI `test:cli-package` passed for the foreground increment; the manual increment's
local evidence uses installed tarballs rather than a rerun of that terminal suite.
Provider-specific browser staging and upgrades from historical published binaries
remain unverified. Existing legacy concurrent-writer, lost-checkpoint and pending
delivery after source-loss limits remain. No package publication or Server
deployment is claimed.

Full Active Path support additionally needs an explicit legacy-to-publication
migration; switching the Adapter manifest or deleting checkpoints is not one.
Tool-result batches outside the exact two-Read layouts and automatic compaction
outside the exact text and Read-turn replay groups need additional native
profiles; none enables them through generic duplicate or parent relaxation.
