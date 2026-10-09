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

The two successful results arrive in call order in the original corpora.
[ADR-0095](../architecture/adr/0095-claude-reversed-read-pair-results.md) also
selects the planned `text@0, Read@1, Read@2` layout completing R1 before R0.
Each native user
record has one `tool_result`; its parent and `sourceToolAssistantUUID` both name
its own call, and its tool ID matches that call. In reverse order the first R1
follows C1 linearly; the remaining C0 result's parent differs from the preceding
physical record. Ordered result parents also differ from their preceding
physical records. The result must have the sampled text/file metadata
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

For reverse completion, the first R1 requires proof of the proposed committed
P/C0/C1/R1 prefix before ACK. Existing private remaining-call fields bind the
next result to C0; reverse pending state is re-proved on restart, including EOF.
An actual older R1 cursor without pending state is adopted after the same source
proof through one metadata-only observation. Its byte/hash checkpoint, Events,
usage and Raw identity stay unchanged. It emits no second R1 result; later idle
polls remain empty, and a wrong next record preserves the adopted ACK. No new
cursor field or projection revision is needed.

Each receipt keeps ordinary per-record budgets; the two receipts need not fit in
one page. Raw receipts can advance independently through admitted bytes while
the Host retains an older parser cursor, and retries prove the same calls again.
Existing projection-4 checkpoints, physical block-slot Event IDs, tool
associations and Raw identity/generation are preserved. Split call records
update one API usage identity at its latest revision rather than summing counters.
Large result values follow the existing bounded tool-details policy; results do
not become user messages or fabricated text fragments. Their exact Event anchors
remain available in Reader; Search covers actual conversation text.

This profile does not admit more calls, tool-only reverse completion,
interleaved/error/async results,
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
An active compaction checkpoint cannot carry partial Event progress: its control
records are Raw-only. A damaged nonzero Event skip is rejected even at EOF,
partial input or a blank line, rather than waiting for a later conversation.

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
enable tails outside these two manual shapes, the selected file reinjection
below or the separate automatic profiles, cross-file continuation, child
compaction, rewind or forks.

## Manual Read file reinjection

[ADR-0092](../architecture/adr/0092-claude-manual-read-file-reinjection.md) and
[ADR-0093](../architecture/adr/0093-claude-larger-manual-read-records.md) admit
the sampled Claude Code 2.1.263 manual root sequence at small and larger Read
sizes. Its ten adjacent
originals are external user, token reminder, text plan at API index 0, two Read
calls at indices 1/2, their ordered successful own-call results, another token
reminder and final text records at indices 0/1 of a later API response. The manual
boundary retains only the final text pair. After the existing summary and local
command controls, two new file attachments reinject result B then A. Each entire
attachment content object must equal the corresponding persisted `toolUseResult`,
including unknown decoded values. Filename, receipt filePath and original Read
input agree literally. The Adapter neither reopens files nor normalizes paths to
create this proof.

Admission streams the exact current committed prefix through the same open
handle. It proves physical adjacency, root Session/CWD/version/ownership, the
Read/API/receipt graph and the complete boundary-to-stdout control chain. The
saved calls map or compaction phase alone cannot authorize a file. Original
records join the proof only after their Events, usage and bytes fully commit;
an Event-only call or fragmented final text cannot be treated as acknowledged.

The two adjacent files commit as one Raw-only parser group, preserving the
existing compaction `resume` phase. Thus compact EOF can commit without waiting
for another process. A later internal Meta Continue and its adjacent zero-token
synthetic assistant form a second Raw-only group. The Adapter proves the already
committed files again and clears compaction only after this whole bridge group
commits. A lone first file or Meta cannot advance eligible source progress.
Complete conflicts fail at the preceding acknowledged group; incomplete second
slots wait without a busy continuation loop. The existing no-file profile keeps
its direct stdout-to-synthetic bridge, authenticated against the actual stdout
leaf; the file branch cannot skip or repeat Meta Continue.

Both groups, their bounded native bookkeeping and all internal controls produce
no Canonical Events or usage. Only real later user/assistant turns append to the
existing root Thread. The sampled Meta and real user share a new prompt, but no
new durable real-user prompt protocol is introduced. Supported opaque cursors,
projection revision 4, Event anchors and Raw object/generation remain intact.
After the committed files, UUID-less `mode` and `atis-latch` bookkeeping is
admitted only after the current prefix, selected files and incoming identity
are proved again. Type names alone cannot authorize progress; the generic
no-file compaction transition retains its existing bookkeeping types.
Independent Raw receipts can advance inside a proved group while the Host keeps
an older parser cursor; retries prove the group again and resume contiguous Raw
bytes. Parser group atomicity does not make Canonical and Raw delivery a single
distributed transaction.

Both native corpora sample one first-slug, text-plan, exact-two successful Read
sequence and reverse file order. Single Read, no-plan layouts, more/other/error/async tools,
changed or repeated file reinjection, children and wider manual/automatic
composition remain outside this increment. Summary and reinjected files enter
model context as provider-generated records; they remain outside Reader/Search
turns. Missing summary API usage is not reconstructed from stdout or model
requests. At caught-up resume EOF, the existing progress Interface need not report
a pending Canonical Session solely because a later process may append a bridge.

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
[U,G,P,C0,C1,R0,R1,A], or the planned reverse-result variant
[U,G,P,C0,C1,R1,R0,A] selected by ADR-0095. U is an external user, G its token reminder, P a single
text plan at API index 0, C/C0/C1 the same response's Read calls at indices 1 or
1/2, R/R0/R1 their successful own-call results, and A a final token reminder.
All six/eight records are physically adjacent and fully committed. The pair
uses each current call exactly once and preserves actual result order. Each result
matches its literal call path, tool ID, parent/source assistant UUID and U's
prompt. Both reminders have their exact native parent edges. A pending Read-pair
result cannot authorize replay before it completes.

The source copies all six/eight records, then appends B/S. Its retained metadata
names only the four/six records from P through A: U/G are copied but excluded
from those arrays. Segment endpoints are P/A, logical parent is A, and both
anchors name the new summary S. In the first-slug layout, every original omits
slug; each copy adds only the same first slug and must otherwise equal the complete decoded original,
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

[ADR-0094](../architecture/adr/0094-claude-repeated-single-read-auto-file.md)
adds two consecutive single-Read automatic rounds. The second originals/copies
all retain the first slug exactly. A historical witness proves both complete
single turns, their original/copy graphs and new B/S identities, and the first
round's real two-record answer. The next user follows that answer leaf; the two
literal Read paths differ. After the second S, one native file attachment must
exactly reproduce the entire first successful receipt, including unknown values.
The Adapter uses stored source evidence rather than opening the referenced file.

That file commits as Raw-only and keeps the required real answer pending. The
existing private pending state recognizes B/S/file as its seen tail and
re-proves the file against the current prefix before accepting a real index-0
answer parented by it. Event fragments and deferred usage preserve the state;
only full answer commit clears it. The selected file answer has a valid recorded
timestamp, a fresh API identity and `end_turn`; known file async/status controls
are absent. Nonzero Event progress at a file checkpoint requires its complete
valid next answer and consistent Event time. EOF/partial input cannot establish
it; zero-progress file EOF waits without busy continuation. These checks verify
cursor/source consistency rather than authenticate arbitrary cursor forgery.
Unsupported complete files/answers retain the caller's input ACK. No cursor
field, round counter or public Interface changes are needed.

[ADR-0096](../architecture/adr/0096-claude-repeated-dual-read-auto-files.md)
adds the sampled two planned dual-Read rounds: first results B/A, one ordinary
external user/reminder/single-text assistant bridge, then second results A/B.
The second eight originals/copies retain the first slug and new B/S retain
their current six P-through-A identities. The historical proof validates both
complete turns, the first answer pair, the ordinary bridge and its selected
API identities. The new user must follow the ordinary assistant; arbitrary
intervening turns cannot authorize this profile.

Two post-summary files reproduce the complete first-round receipts in Read
call order A/B, independently of the old B/A result arrival order. Each commits
independently as Raw-only. The existing pending state reconstructs B/S plus
zero, one or two files from authenticated source bytes; the real answer requires
the complete sequence and follows the second file. First-file EOF remains
pending, and Event progress cannot skip the second required file. Current and
historical literal paths are distinct; filenames and whole stored content objects
must match their historical receipts, including unknown values. The Adapter
does not reread referenced files. Old acknowledged Events, usage and Raw identity
survive ordinary upgrades through the same public collection Interface.

The older single/two-Read corpora each establish one first-slug round and two
ordinary resumes. The new planned reverse corpus establishes its first-slug
round and one ordinary resume after a complete public ACK; the repeated dual
corpus continues that actual Session. Further rounds, other result-order
combinations or ordinary bridges, additional reinjected files, same-path changes, tool-only layouts without P,
other/more/error/async/interleaved calls, children and Active Path replacement
remain outside these profiles. Manual file reinjection keeps its separate
profile above; text replay retains its proved repeated-slug scope.

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
and cursor policies, not native format limits. Ordered results retain ordinary
16 MiB parsing and requested source-page admission. Planned reverse recovery
selects four P/C0/C1/R1 LF frames within that same 256 KiB tail; each selected
frame, including its first R1 receipt, fits 64 KiB. Its prospective prefix must
remain resumable before ACK, and the remaining R0 retains ordinary 16 MiB
parsing. These bounds do not broaden the ordered or larger manual profiles.
Proof costs O(committed
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
The two-round single/planned-dual Read file witness retains at most 64 complete physical LF
frames within 4 MiB. Selected original/copy/control/first-round answer frames and the
single or two reinjected files each fit 64 KiB including LF; the selected dual
ordinary bridge has the same frame policy. These additional historical
proof limits do not expand the existing automatic group limits or ordinary
parsing. Oversized earlier unrelated history may fall out of the witness window;
selected history beyond it is unsupported. Serialized retention is not an RSS
bound, and the same-handle prefix proof is not an atomic snapshot.
These frame caps apply after a complete LF record is classified. A partial
incoming prior-file line retains ordinary 16 MiB scanning until it completes;
its whole selected frame must then fit 64 KiB.
The second replay group and each file require proof of their proposed
committed prefix before ACK. Appending B/S or the file must still leave the
complete witness inside that window; otherwise the Adapter preserves the
preceding recoverable ACK.
Manual Read reinjection allows selected original receipt slots R0/R1 up to
2 MiB each, selected file frames up to 1 MiB each and the atomic file pair up to
2 MiB. Other selected originals, the five compact controls and Meta/synthetic
frames retain 64 KiB; the Meta/bridge group retains 128 KiB. All frame limits
count complete UTF-8 JSONL including LF, escaping and unknown values, rather
than file-body bytes. The native larger sample reads two 98,304-byte files
without truncation; these policies provide headroom above that sample, not a
native ceiling or support for every ordinary 16 MiB receipt.
A bounded ring retains ten potential originals and five controls. Candidate
classification chooses storage capacity only; selected positions and the full
graph independently determine admission. Oversized unrelated prehistory falls
out of the ring without adding a new source limit. A valid selected graph uses
at most 6.8125 MiB of serialized original/control/file frame equivalents; the
untrusted candidate ring and control/file slots can retain 22.3125 MiB before
validation. The scanner, transient decoding, JSON objects and equality worklist
are additional memory, so these figures are not RSS guarantees.
Both groups must fit fresh requested source capacity even with Raw disabled;
insufficient remaining page capacity defers the entire group. An unknown first
partial line keeps ordinary 16 MiB scanning; the recognized second file slot
uses 1 MiB bounded lookahead and the second bridge slot retains 64 KiB.
Old no-file manual profiles keep their ordinary record limits. Prefix proof adds
O(committed prefix) I/O/hash and preserves existing concurrent-writer limits.
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
An unsupported appended source record can stop parsing before newly requested
Raw backfill of an older eligible prefix. Existing receipts remain valid, but
the capability or exact source repair must allow collection to proceed; Raw
backfill does not bypass an unsupported tail.

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
The [manual Read reinjection fixture](../../adapters/claude/fixtures/native-manual-read-reinjection-2.1.263/README.md)
retains six native snapshots from one controlled Claude Code 2.1.263 Session.
Both synthetic files were actually read; compact retains only the two final
text UUIDs, then reinjects file B/A without replayed UUIDs. Complete stored file
content objects equal their corresponding original receipts. The resumed model
requests load the summary and file reminders, followed by the internal
Meta/synthetic bridge and actual conversation. The corpus's logical expectations
are twelve Events and four real API usage identities at compact, fourteen/five
after continuation and sixteen/six after the second continuation, ending at
188 input / 90 output mock counters. The summary response has no persisted
assistant usage; its separate stdout model counters are excluded. Config and
workspace were isolated, but inherited HOME was unrecorded. These source facts
do not establish implementation, installed-package or integration acceptance.

The initial manual Read reinjection increment was integrated through
[PR #193](https://github.com/SingleMai/ATape/pull/193) after its final-commit CI
and Security gates passed. Its local checks included 580 Adapter tests, installed
Claude package verification, four Collector/Server E2E tests and 92 authenticated
HTTP/PostgreSQL managed-daemon runs. Eighteen actual prior-Implementation upgrade
checks and 90 independent fault/resource checks preserved acknowledged progress.

The [larger manual Read fixture](../../adapters/claude/fixtures/native-manual-large-read-reinjection-2.1.263/README.md)
adds six native snapshots from a fresh, initially empty HOME/config/workspace.
Claude actually reads two complete 98,304-byte files, compacts and resumes twice.
After literal path substitution, original receipt frames are 198,628 bytes and
reinjected file frames are 99,278 bytes, including LF. The final source has
31 UUID records and 57 physical lines; extra UUID-less mode/atis-latch records
appear before compact and after the files. Both complete file content objects
still equal their corresponding receipts. Selected model requests retain the
full summary and short text, but represent large Read-bearing text with exact
hashes, byte counts and endpoint previews. This source evidence establishes
one larger instance of the selected graph, not all native Read sizes or layouts.
Its expected final logical totals are sixteen Events, six recorded real API IDs
and 188/90 mock counters. Missing summary usage remains unavailable.

For the larger manual Read increment, Claude typecheck and all 646 Adapter tests
passed, including 66 new public Interface cases and the initial 97 manual cases
with only their three capacity-dependent expectations updated. Checks cover both
native corpora, all thirteen LF cuts and four partial slots, exact and above
2 MiB receipt/1 MiB file/2 MiB group limits, unchanged 64 KiB selected controls,
fresh/remaining capacity with Raw off/on, final-text fragmentation and genuine
Event-only pending usage. Candidate-like records in a nonreceipt position still
fail its smaller selected cap. Equal deep/wide unknown values remain fully
compared; changed values reject without new ACK. After-file mode/atis-latch
identity conflicts reject, while those types after a no-file stdout remain
unsupported. Existing automatic and no-file bounds remain covered.

The installed Claude `verify:package` passed both manual corpora's six native
snapshots, thirteen derived LF cuts, four partial file/Meta/bridge slots and four
independently advanced Raw receipts paired with an older parser cursor. Every
page recreates the installed runtime and retries identical unacknowledged input.
Four additional large-file fresh-capacity cases cover below/exact capacity with
Raw off/on at the selected group's EOF. Both corpora end at sixteen unique Events,
six real usage IDs and 188/90 latest mock counters, with stable prefixes, own-call
associations and complete Raw bytes. Large successful Read results retain their
completed status and omit oversized Canonical tool details under the unchanged
shared policy. Prior installed package scenarios also passed.

Independent checks generated thirteen actual opaque checkpoints with the
previous merged Implementation at `999246918097bf90194c38797fa709e9312c33aa`,
covering C0/C1, R0 with pending usage, R1, final text and each boundary/control
through stdout. That Implementation admits the ordinary larger Read turn but
rejects the first reinjected file under its old 64 KiB limit. This Implementation
resumes those acknowledged checkpoints through both continuations with all old
Event objects unchanged, latest-once usage, the same Raw object/generation and
complete contiguous bytes. Restoring the exact old prefix stays idle. These are
prior Git Implementation upgrades, not historical published binary acceptance.
Two additional genuine old C1/A0 Event-only checkpoints resumed pending usage
without replaying their published Events. Together with fourteen independent
capacity/identity/cancellation probes, all 29 checks passed. The derived exact
envelope uses 2 MiB receipts and 1 MiB files; oversized receipts/files and the
unchanged 64 KiB boundary/summary limits fail with typed capacity errors. Invalid
post-file metadata and no-file mode/atis records reject without changing input
receipts. Cancellation was observed during public collection with a 1 ms abort
timer, followed by identical retries on a reopened runtime; the exact internal
interruption point was not observed.

A fresh current-bundle-only Node 24.18.0 process on Darwin measured the explicit
6,317,932-byte padded derivative at the exact receipt/file caps. After ordinary
capture through stdout, eight public collection pages completed both groups,
two resumes and idle in 1.26 seconds. Sampled RSS increased from approximately
227 MiB to 251 MiB; process-lifetime high-water was also approximately 251 MiB.
The process retained the source text, runtime and setup allocations without
forced GC. Sampling can miss synchronous peaks; this serial single-source
measurement is neither an Adapter-only RSS bound nor a concurrency guarantee.

The expanded authenticated HTTP/Docker PostgreSQL contract passed 113 independent
managed-daemon runs against installed CLI/Claude tarballs: all 92 prior runs plus
15 larger source phases and six unchanged polls. Initial attribution captures
nine Sessions and ten Raw objects, excluding the foreign source. The larger
Session preserves twelve Events/four API IDs and 130/64 counters across compact,
files, mode/atis bookkeeping and Meta/bridge, then completes sixteen/six at
188/90. Lone file/Meta slots preserve their preceding cursor and eligible Raw
prefix; full groups commit once. Reader tool results retain completed status,
own-call anchors and omitted oversized details. Real-message Search anchors,
internal/tool exclusion, stable old Reader prefixes, Raw object/generation and
complete paged bytes passed. Both ordinary and compressed opaque cursor forms
are accepted by the contract fixture without changing the production format.
Raw policy/backfill, unsupported-source repair and source-deletion retention
remain covered; the required non-skipped Claude contract guard passed.
All four Collector/Server E2E tests, CLI typecheck, Go HTTP compile, architecture
and documentation guards passed. These are local implementation and integration
checks; final PR gates, publication and Server deployment have separate evidence.

The repeated single-Read increment uses five native snapshots from a new Claude
Code 2.1.263 Session: seed, warmup, first automatic round, second automatic round
and ordinary resume. The first round received a complete public Adapter ACK
before the second native invocation. Both rounds read distinct real files; the
second source keeps the common slug and its one file contains the entire first
successful receipt. The [fixture ledger](../../adapters/claude/fixtures/native-repeated-auto-read-2.1.263/README.md)
records literal prefix cuts, source/request hashes, excluded setup failures and
the separate reversed two-Read capture. That capture did not reach a first
complete Adapter ACK and is not positive repeated-profile evidence. Final
logical totals are eighteen Events, seven recorded real API identities and
380163/117 controlled counters; absent summary usage is not fabricated.

All 741 Claude Adapter tests passed, including 95 new public Interface cases.
They cover existing-slug copies, historical own-call/answer graphs, complete
unknown-value equality, old/current-file confusion, pending and fragmented
answers, Raw off/backfill/advanced receipts, damaged cursors and source repair.
Exact 64 KiB file/selected-frame and 64-frame/4 MiB historical bounds are covered.
The prospective summary/file prefix must fit before ACK: an added file or B/S
that evicts required history rejects while preserving the previous checkpoint.
Nonzero file-tail Event progress requires a valid complete next answer and its
recorded Event time; genuine Event-only checkpoints and deferred usage still
resume. These are consistency checks, not authentication against coordinated
cursor forgery or timestamp collisions.

The final installed bundle passed all prior package scenarios plus five native
snapshots, 36 derived LF cuts, seventeen partial slots, seventeen independently
advanced Raw receipts and twelve fresh-capacity cases. Independent acceptance
resumed fifteen actual opaque checkpoints produced by the previous merged
Implementation at `e127772632dc63b94cb230f12aed09a58f58d4b1`, including two genuine
Event-only checkpoints, and passed 29 capacity/identity/cursor/repair/cancellation
probes. Old Event objects and Raw object/generation stayed stable, with complete
physical bytes and latest-once usage. This uses the prior Git Implementation;
upgrades from historical published binaries remain unverified.

The expanded authenticated HTTP/PostgreSQL contract adds seventeen native source
phases and six idle polls to the previous 113 runs: 136 independent installed
managed-daemon runs, ten Sessions and eleven Raw objects. Local acceptance passed
on the candidate before the final prospective-window guard
(`dc0e1261fb26dc929b1d51dfef03d54b7208f4b3ffc81cc01f69564f09a49b95`
source SHA-256), as did all four Collector/Server E2E tests. It verifies stable
old Reader Events, both own-call result anchors, latest usage, real-message Search
anchors, internal/tool exclusion, complete contiguous Raw and deletion retention.
The final Implementation's typecheck, installed-package/upgrade/fault checks
and 741 tests passed; exact final-head PostgreSQL/E2E acceptance remains a required
PR CI gate with its separate run evidence. No publication or manual Server
deployment is claimed by these local checks.

The planned reverse-result increment adds
[four native snapshots](../../adapters/claude/fixtures/native-reversed-read-pair-2.1.263/README.md)
from the separate Claude Code 2.1.263 dual Session. Its first two successful
Read results arrive B/A, each naming its own call. The first automatic group
copies all eight original records and retains their actual result sequence.
One later ordinary native process ran only after the unchanged first round
received a complete public Adapter ACK. That gate used an offline initial
candidate; the ledger identifies its source and bundle separately from final
acceptance. Final source totals are fourteen Events, five persisted API IDs
and 190122/77 controlled counters. Those four snapshots stop before the second
dual round acquired below; absent summary API usage remains unaccounted for.

All 812 Claude Adapter tests passed on the final Implementation, including
71 new public Interface cases. They verify fresh reverse capture, complete
copy equality, physical result order, pending EOF/partial results, conflicting
next records, exact retries, damaged remaining-call state, Raw off/backfill and
independently advanced Raw. Proposed first-result ACKs must fit four selected
LF frames in the existing 256 KiB tail, each at most 64 KiB including LF.
The exact four-by-64-KiB boundary succeeds even after unrelated prehistory;
recognized reverse cursors disguised as ordered pending state reject at EOF.
The remaining result keeps ordinary large-receipt behavior, and ordered and
larger manual profiles remain covered by the previous tests. These checks
establish source/cursor consistency, not authentication against coordinated
cursor forgery.

Independent acceptance resumed twelve saved inputs produced through the actual
previous-main public factory at `41f9c708f9e973a4b2276b073751b27b67bc7d7e`:
eleven reverse inputs, including two genuine Event-only checkpoints and repeated
blocked states, plus an actual ordered pending-result representative. All
reverse inputs complete the fourteen/five/190122/77 source without replaying old
Events; the ordered representative retains its twelve/four/130/64 totals.
Twenty independent fault and boundary checks passed, including a genuine old
ACK on a derived exact four-by-64-KiB prefix. An old B-only EOF ACK receives one
metadata-only adoption with stable bytes/hash, Events, usage and Raw identity;
even a complete wrong next record waits for a separate collection page before
rejecting. Partial A, advanced Raw, malformed pending state, changed source,
own-call/receipt contradictions and repaired retries preserve acknowledged
progress. Cancellation acceptance uses an already-aborted signal followed by
normal exact retries; it does not establish in-flight atomicity. This uses the
previous Git Implementation, not an historical published binary.

The final installed Claude bundle passed all prior package scenarios plus four
native snapshots, 23 derived LF cuts, eleven partial slots, twelve independently
advanced Raw receipts and fourteen capacity cases. Claude and CLI typechecks,
all four Collector/Server E2E tests and architecture guards passed on the same
production source. The authenticated HTTP/Docker PostgreSQL contract passed
151 independently restarted installed managed-daemon runs: the prior 136 plus
eleven reverse-source phases and four idle polls. Initial capture includes
eleven Sessions and twelve Raw objects. Both completed own-call result anchors
retain B/A order; original Reader Event prefixes, ordinary message Search
anchors, internal/tool exclusions, latest API usage, contiguous exact Raw,
Raw policy/backfill and deletion retention passed. The required non-skipped
Claude contract guard passed. Final source SHA-256 is
`01485f5a8e490102cacfe924b2f48fde8c165bb34bcb6373a7e80cc937f152ca`;
the installed bundle SHA-256 is
`67a56a3089a4e1936ff34eeb044d3b31167d347b6f4083876957f952a44b2576`.
These are local implementation and integration checks; exact final-head PR
gates, publication and manual Server deployment have separate evidence.

The repeated planned dual increment resumes that same native Session after a
complete public ACK of its 46-LF ordinary source on merged main
`ffd17ee024461ee19f80933e22ad0ce043520497`. The gate has fourteen unique Events,
five persisted API IDs, 190122/77 controlled counters and all 28,697 Raw bytes
with zero pending Canonical/Raw. One subsequent native process produced a
74-LF source with eight existing-slug originals/copies, one new automatic B/S,
two historical files in call order A/B and a real two-block answer. R1 results
are B/A and R2 results are A/B; each result binds its own call and actual disk
receipt. The complete source logically contains twenty-two Events, seven
persisted API IDs and 380163/117 counters. The two summary API usage identities
are absent from JSONL and are not fabricated from model-response counters.
Original controls, actual argv/environment, exact source prefix, full request/SSE
hashes and declared fixture path substitutions are recorded in the
[new native fixture](../../adapters/claude/fixtures/native-repeated-dual-read-2.1.263/README.md).
The old factory's actual blocked input remains at LF58 with twenty Events,
six API IDs, 380122/94 counters and 36,174 contiguous Raw bytes. The candidate
must resume that input rather than reconstruct a summary/file checkpoint the
old Implementation never acknowledged.

A separate ordinary native resume ran only after the frozen initial candidate
completely ACKed R2's 51,063 original source bytes. It added one external user,
token reminder and single-text assistant, with no new Read or compact boundary.
The unchanged binary produced an 80-LF, 54,083-byte strict extension; its public
ACK has twenty-four unique Events, eight persisted API IDs and 380192/130
counters with full Raw and zero pending. This gate identifies its initial
source/bundle independently of final acceptance; it does not establish a third
automatic round.

All 904 Claude Adapter tests passed on the frozen final Implementation: the
previous 812 plus 25 dual workflow, 52 source-proof and 15 historical-bound
cases. They cover both independent file ACKs, pending EOF/partials, genuine
Event-only deferred usage and answer fragments, unknown-value equality,
ordinary bridge/control faults, selected API identities, repair, Raw policy
and requested capacity. The exact 64-LF historical window succeeds; adding
frames that would evict its first selected original rejects the prospective
S/first-file/second-file ACK while retaining the preceding resumable input.
Selected bridge/file frames pass at 64 KiB including LF and reject at one byte
more; unrelated earlier source metadata exceeding 4 MiB remains admissible.

Independent acceptance resumed fourteen distinct genuine previous-main opaque
inputs from `ffd17ee024461ee19f80933e22ad0ce043520497`, including first-round
summary/answer progress, Event-only inputs, ordinary EOF, the second round's
pending first result and its actual blocked LF58 input. Every input completes
R2 at twenty-two Events/seven API IDs/380163/117 without replaying old Events,
moving copied usage to a new source revision or replacing Raw identity. Twenty
independent sequence/cursor/capacity and genuine Event-only checks passed on
the same source/bundle. These use the previous Git Implementation and explicitly
substituted controlled literal CWD, rather than a historical published binary.

The installed Claude package passed its prior scenarios plus three native
snapshots, 24 derived LF cuts, thirteen partial slots, fourteen independently
advanced Raw receipts and twenty capacity cases. Raw-off capture followed by
Raw-on backfill preserves all twenty-four final Events and eight API identities.
Claude/CLI typechecks, four Collector/Server E2E tests, documentation and
architecture checks passed. The required non-skipped authenticated HTTP/Docker
PostgreSQL contract passed 169 independently restarted installed managed-daemon
runs: the prior 151 plus twelve second-round/ordinary stages and six idle polls.
Reader prefixes, both rounds' own-call anchors and result order, message-only
Search, actual persisted usage, exact contiguous Raw, policy/backfill and
source-deletion retention passed. The usage query includes both actual native
acquisition dates. Final source SHA-256 is
`640f7c11a57b957b63b854ae1b10e41844d65d8ead6ec0608bc9df923d0e5b85`;
the installed bundle SHA-256 is
`d540f752884bbe77464a00f7a3001fb903f97c507ef569f6ea9e66d8d727fa94`.

CLI `test:cli-package` passed for the foreground increment; the manual increment's
local evidence uses installed tarballs rather than a rerun of that terminal suite.
Provider-specific browser staging and upgrades from historical published binaries
remain unverified. Existing legacy concurrent-writer, lost-checkpoint and pending
delivery after source-loss limits remain. No package publication or Server
deployment is claimed.

Full Active Path support additionally needs an explicit legacy-to-publication
migration; switching the Adapter manifest or deleting checkpoints is not one.
Tool-result batches outside the exact two-Read layouts, automatic compaction
outside the exact text and Read-turn replay groups, and manual file reinjection
outside the selected two-file control chain need additional native profiles;
none enables them through generic duplicate or parent relaxation.
The next completeness increment needs new native evidence for further automatic
rounds or a new manual Read profile before extending admission. Additional prior
files, larger automatic receipts, single/no-plan manual layouts and Active Path
adoption remain separate work.
