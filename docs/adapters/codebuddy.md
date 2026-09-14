# CodeBuddy Code CLI Adapter

The CodeBuddy Adapter reads local primary and forked CLI JSONL Sessions and completed foreground/background Agent families through the existing
[source-capture runtime](package-manifest.md#bounded-source-capture-capability).
The Host owns Project attribution, redaction, stable revisions, frozen delivery,
atomic publication, independent Raw receipts and crash recovery. No Server schema
change or alternate uploader is required. The receiving Server must advertise
`atape.publication.v1`.

## Install and sources

Build/install instructions are in the [package README](../../adapters/codebuddy/README.md).
Add **CodeBuddy Code CLI** through Tools and updates, preserving the existing tool
selection. Package installation alone does not enable capture; tool selection
applies to connected Projects. See [CLI setup](../cli/setup-and-adapters.md).

`ATAPE_CODEBUDDY_HOME` overrides `CODEBUDDY_CONFIG_DIR`, otherwise the source home
is `~/.codebuddy`. Both overrides must be absolute. Discovery enumerates
`projects/*/*.jsonl` without following symlinks. Opening a root then reads only
child histories proved by its native Agent receipts; unrelated nested files are ignored.
Directory names are locators, not proof of Project membership. For an ordinary Session, the first user record supplies `sessionId`, `id` and
absolute `cwd`; the native Session ID must match the file basename. A fork also
requires native sidecar evidence and its first fork-owned user record, as described
below. Duplicate storage IDs are diagnosed instead of merged.

Directory Projects use Host path attribution; Git Projects use its existing
original-source attribution across worktrees/clones. Later CWD changes or source
relocation do not reassign the Session. Missing original attribution remains
unknown, never inferred from the configured Project locator.

## Source mapping and supported scope

Official references: [local directory structure](https://www.codebuddy.ai/docs/cli/codebuddy-dir), [CLI resume/fork options](https://www.codebuddy.ai/docs/cli/cli-reference) and [SDK Session management](https://www.codebuddy.ai/docs/cli/sdk-sessions). The installed 2.124.0 implementation and controlled samples establish the narrower scope below.

The evidence-bound profiles are `codebuddy.cli.jsonl.linear.1` and
`codebuddy.cli.jsonl.fork.1`, extended by `codebuddy.cli.jsonl.compaction.1` and
`codebuddy.cli.jsonl.fork.compaction.1` when supported compaction is present. `codebuddy.cli.jsonl.family.1` covers the
completed foreground Agent family described below, including root compaction.
`codebuddy.cli.jsonl.family.background.1` additionally covers the bounded automatic-team
background launches described below; `codebuddy.cli.jsonl.family.background.turns.1`
adds proven serial continuation and framework notifications. `codebuddy.cli.jsonl.emergency.1`
and `codebuddy.cli.jsonl.family.emergency.1` cover the completed emergency compaction
sequence below. `codebuddy.cli.jsonl.family.fork.1` adds copied foreground families, new children and validated foreground continuation in forks, as described below. All are tested with native
CodeBuddy Code CLI 2.124.0 samples on macOS arm64. It is not a promise for IDE,
VS Code extension, all CLI versions, or other platforms.

| Native record | Canonical and reader | Raw |
| --- | --- | --- |
| First `message`, role `user` | Session/root Thread from native Session ID; Origin key from Session ID + first record ID | Original JSON line in an observation envelope |
| `message.content` input/output text | ACP user/agent text; Event identity from Session + record ID + physical block slot | Same record, unknown fields retained |
| `reasoning.rawContent` (fallback `content`) | ACP thought text | Same record |
| `function_call` | ACP tool call; scoped `callId`; bounded parsed arguments | Original arguments retained |
| `function_call_result` | Correlated tool result; native error fields override misleading `completed` status | Original output and provider details |
| `message.usage` + `providerData.messageId/model` | One usage item per model response; repeated identical usage deduplicated | All original usage fields |
| File-history snapshots | No fabricated conversation message | Same record |
| Unknown blocks / external images | Omitted from Canonical, partial capture | Stored only if Raw enabled; referenced blobs are not read |

Input counters already include cached input; output includes reasoning. They are
not added a second time. Missing counters remain unknown. Currency/credit values
are not interpreted as money. Per-response usage belongs to the Thread containing that native model response.
Parent tool results do not add the child response counters again.
Tools are bounded through the shared value contract; oversized details are omitted
with partial fidelity. Spill placeholders remain placeholders, mark partial and
do not cause arbitrary referenced file reads. Search uses the existing bounded
Canonical projection, never full Raw/tool-value indexing.

## Ordinary multi-tool responses

CLI 2.124.0 can store two ordinary tool calls from one model response with the
same native record `id` and `parentId`, but distinct `callId` values. The controlled
Read/Read sample proves this sibling shape, followed by separate results in the
normal parent chain. The first call retains its existing Event and Raw record
identity; later siblings use a separate identity namespace qualified by their
native call ID. Raw JSON and its original shared record ID remain unchanged.

Only adjacent siblings with matching Session, parent, agent and model-response
metadata are admitted. Every sibling must have one matching result before the
group is exposed; unfinished or conflicting groups preserve the previous target.
In the native sample only the final call carries normalized response usage, so
the pair contributes one usage item. Earlier sibling usage, grouped Agent/Task/
SendMessage delegation, and noncontiguous repeated revisions remain unsupported.

The native three-turn sample contains 11 Events and four usage samples totaling
28,477 input, 145 output and 21,376 cached-input tokens. Cache is included in input.
The runtime, standalone tarball and installed CLI contract replay initial history,
complete parallel reads and ordinary resume, preserving the earlier prefix. The
contract also checks distinct call/result and Raw references, exact usage, pending
and invalid-group preservation, Raw off/on, Raw-only recovery and frozen activation
recovery after source deletion. This does not establish concurrent message delivery
or any new child-delegation format. Browser acceptance on 2026-09-14 verified
three real turns, both tool inputs, both matching marker outputs and the recovered
final reply in the existing Web reader. The 116 runtime tests, Adapter/CLI typechecks,
standalone tarball and documentation/architecture checks passed locally.

## Native CLI forks

`--resume <id> --fork-session` copies history into an independent JSONL file and
writes a sidecar containing `forkedFrom`. Copied records retain their previous
Session IDs and message IDs; the first newly submitted user record carries the
new fork ID. That ID must match the file basename. This first fork-owned record’s
ID and CWD anchor the fork’s Origin; copied CWDs never authorize the fork for a
Project. A prefix-only fork has unknown attribution until that record exists.

In CLI 2.124.0, deserialization can restore the original root `sessionId` while
retaining the fork filename as `storeId`. Native nested forks still record that
root in `forkedFrom`, and ordinary fork resume appends records under the root ID.
The Adapter therefore validates the complete linear parent chain and identity
changes at user turns. After the first fork-owned turn, only the fork ID and its
recorded root ID are accepted. Compaction follows the profile below; unknown sidecar fields remain unsupported. Native fork resume can set
`isSubAgent` even for an ordinary root; that flag alone does not establish child membership. `/branch`, which rewrites IDs and stores `forkedAt`,
is a different shape and is not covered by these samples.

Forks are independent Sessions containing their copied prefix. Event, tool and
usage identities are scoped to the fork storage ID, so its updates cannot replace
the original Session. `forkedFrom` is retained in the first Raw record’s `sidecar`
envelope; it is not fabricated into an immediate-parent Thread relation. Parent
files need not remain present. Nested fork and resume samples include eight usage
records: 55,032 input, 417 output and 22,144 cached-input tokens. These are the
usage of the captured history, including copied responses; they are not proof of
newly incurred spend. Cache is already part of input and is not added twice.

Ordinary resume is a linear append. Every projected record must extend the
previous record through `parentId`; first identity and CWD establish Origin.
Identical repeated records are deduplicated; conflicting repeated IDs are
unsupported except for the proven ordinary-tool siblings described above. A complete rewritten file with the same proven Origin can produce a
replacement target and Host-assigned revisions. This does not establish support
for native rewind/compaction semantics.

Sidecar fields other than `forkedFrom`, in-file branching and unknown parent-linked
records are rejected without replacing previously published history.

## Forks with copied foreground children

A CLI fork copies completed Agent receipts in its root history, while child files
remain under the original native parent Session directory. The Adapter follows
the receipts visible in the fork. For each copied child it finds the latest completed `lastId`,
includes the completed assistant at or following that boundary, and
validates the selected prefix against all visible prompts and `afterId` receipts.
This also retains the final answer when native `lastId` names its preceding
reasoning. Nested child receipts are read from that selected prefix, so each
level has its own boundary.

Original children may subsequently append more turns. Those later records do not
enter the fork's Events, usage, Raw or Search and do not change its selected head.
A resumed child whose earlier turns were already copied retains those turns.
The fork is an independent Session with all Event/tool/usage identities scoped
to its storage ID. Its first fork-owned user CWD owns the whole copied family;
copied root or child CWDs cannot move it to another Project. The original root
JSONL need not remain present, but the referenced child files are required until
a complete view is frozen. A missing or incomplete selected child preserves the
entire previous target.

The CLI 2.124.0 native corpus covers a single-child fork and a three-level fork,
ordinary parent resumes, and later original child/leaf continuation. The resumed
single-child fork has two Threads, 12 Events and five usage records (39,864 input,
177 output, 19,136 cache). The resumed three-level fork has four Threads, 30 Events
and 13 usage records (98,806 input, 577 output, 56,896 cache). These are historical
copied counters, not newly incurred spend. Cache is already part of input.

Unaccounted shared-child turns, background children in forks, fork subagents
and emergency compaction in forks remain unsupported.
The Adapter still reads and stamp-checks bounded complete physical files before
selecting prefixes; growth beyond the shared file/record/byte limits is diagnosed,
even when it lies beyond the copied boundary. A malformed physical file requires
retry rather than an unverified partial read.

## New foreground children from a fork

A completed new Agent delegation after the first fork-owned user record can add
child Threads. The native call's `sessionId` supplies its storage parent: the
first fork invocation writes under the fork ID, while an ordinary resumed fork
restores the original root ID and writes new children there. A nested child uses
its immediate parent's native UUID. The Adapter reads only the exact path named
by this call and its structured receipt; it never searches other directories for
a matching agent ID. Directory location does not change Canonical membership or
Project attribution: all new descendants belong to the fork's Session and Origin.

Copied children retain the receipt-selected prefixes described above. New
children require their complete histories to match their delegated prompts and
completion receipts; a later unaccounted turn cannot be silently discarded as a
copied prefix. The original root JSONL is unnecessary. Missing children, unfinished
responses or mismatched prompts preserve the previous complete fork target.

The CLI 2.124.0 corpus covers a copied seed child, a new child created during the
fork command, a new parent/leaf created after reopening the fork, later original
seed-child growth, and ordinary fork resume. The final view has five Threads,
31 Events and 12 usage records: 87,179 input, 659 output and 53,248 cache tokens.
These totals include copied historical responses; cache is part of input.
Completed foreground `Agent resume` is supported under the continuation constraints below.

## Foreground child continuation in forks

A fork can resume a copied child or a child it created, retaining the same child
Thread. All delegated prompts, `afterId` links, completed turns and native child
Session identity must agree. Copied parents can also resume their copied leaves;
each level is validated against its own receipts. Usage remains attached to the
response's original Thread and is emitted once.

Native CLI resume can split a fork-created child's history across two files.
The first invocation writes under the fork ID; a later invocation restores the
original root ID and appends only its new turn under that directory. The Adapter
uses the ordered storage parents established by the Agent calls, reads each exact
path once, and validates the joined records as one history. The first continuation
row must link through the receipt's `afterId` to the earlier completed turn.
No directory scan, invented root or replacement Thread repairs a missing fragment.
All physical parts count toward the shared limits and receive final stamp checks;
all remain necessary until the complete view is frozen. Revisiting an earlier
storage parent after switching away remains unsupported.

A copied child's selected prefix extends only through the latest receipt in the
fork. Later original-child growth stays outside its Events, usage, Raw and Search.
If the fork then resumes past an intervening original-owned turn that has no
matching delegation in its history, the complete target is rejected and the old
selected head is retained. The Adapter does not silently import that extra turn
or stitch across its missing boundary. This native divergence is a documented
limit; reading the transcript does not mutate or repair the source files.

The direct continuation corpus has three Threads, 31 Events and 13 usage records
(101,862 input, 629 output, 66,944 cache), including both storage fragments. The
copied parent/leaf continuation corpus has four Threads, 39 Events and 17 usage
records (129,884 input, 1,052 output, 66,112 cache). These include copied historical
usage; cache is part of input. Background continuation in forks and emergency
compaction in forks remain unsupported.

## Completed foreground Agent families

Native `Agent` call/result pairs establish membership through structured
`providerData.toolResult.subAgent` receipts. A child is stored at
`<parent-native-session-id>/subagents/<agent-storage-id>.jsonl` within the root's
Project bucket. Its internal Session UUID differs from the `agent-*` storage ID;
nested children use their parent's internal UUID for the directory. Neither the
child CWD nor that directory independently establishes Project ownership. The
root's original CWD and Origin own the entire family.

The Adapter validates the delegated prompt, agent type, completed assistant turn,
receipt `lastId`, and resumed `afterId` chain before exposing any member. Native
`lastId` can point to reasoning before the terminal response, so it is checked
inside the turn rather than used as a visibility cutoff. Repeated calls that
resume the same storage ID append to one Thread. Event, tool and usage identities
are scoped by the root storage ID plus child storage ID; parent and child updates
cannot overwrite one another. Each delegated turn follows its parent call and precedes the result; the complete
family receives the global event order required by the Host.

Each parent Agent tool call links to its child Thread. Nested calls preserve the
Thread parent path, and Reader/Search can open and anchor the actual child Events.
Raw envelopes retain both the owning root Session ID and child's storage Thread
ID, alongside the unchanged native JSONL containing its internal UUID. Usage is
attributed to the response's Thread, without copying parent tool-result counters.

The native corpus covers a custom foreground Agent, its ordinary resume, a custom
Agent calling another child, parent `/compact`, and a built-in `general-purpose`
Agent afterward. It yields five Threads, 37 Events and 15 usage records: 108,859
input, 2,886 output and 57,664 cached-input tokens. Cached input is included in
input. Orphan files are not discovered as independent Sessions. A pending Agent
call, missing/truncated child, mismatched receipt or unproven extra child turn
rejects the complete new target; all previously published family members remain.

Named/team and fork subagents and manual/pre-message child compaction remain
unsupported. Forks can retain copied foreground histories and create new foreground children as described above. Completed foreground child
emergency compaction is described below. The next section defines the narrower supported
automatic-team background shape. Copied foreground boundaries use the native
completion evidence above; other shapes need additional evidence before extending
membership.

## Completed background Agent launches

In CLI 2.124.0, `run_in_background: true` launches an Agent as a member of an
automatic team. Its parent result has `providerData.toolResult.renderer.type:
team-member-spawned`; the renderer's JSON value supplies `taskId`, member name,
team name, description and delegated prompt. It has no foreground `subAgent`
receipt. The Adapter validates that structured value against the call and the
root's `_auto_<native-session-id>` team, then reads the corresponding
`<root-native-session-id>/subagents/<taskId>.jsonl`. It does not read team configs,
mailboxes or task output files, or infer membership from human-readable output.

This profile admits root-level launches with one completed child turn. The child
must start with the exact native `teammate-message` initial assignment matching
its member name and delegated prompt, and end with a completed assistant message.
The reader shows the delegated prompt; the full wrapper stays in Raw. Parent
calls link to their child Threads, and response usage belongs to the originating
Thread. Pending, missing or truncated children, repeated launch identities and
unproven extra child turns reject the entire new target and retain the whole
previous publication. A completed parent `TaskOutput` tool is not proof that the
child has finished; the sample reports a running task at that point.

The native corpus contains two background launches across ordinary parent
resume, followed by another tools-disabled parent resume: three Threads,
24 Events and nine usage records, totaling 74,371 input, 1,162 output and 43,072
cached-input tokens. Cache is included in input. The first child finished after
the parent's final reply. The family uses deterministic delegation traversal for
the Host's global order, retaining native timestamps; this order does not imply
that a background child completed before its spawn result.

The second child called `SendMessage` once. Its successful tool result and final
reply are captured in that child Thread. The controlled local team-lead mailbox
received the marker, but neither that parent run nor its subsequent ordinary
resume appended an inbox message to the root JSONL. The Adapter therefore does
not fabricate a parent notification from child output or mailbox state.

## Serial background continuation

After a completed background child turn, a root `SendMessage` with `type: message`
can append another turn to the same Thread. The recipient must resolve uniquely
to an earlier automatic-team spawn. Both the structured `send-message` renderer
and delivery JSON must match the sender, recipient, summary and content. The
child's next user record must contain that exact native team-lead wrapper and
extend its prior completed turn. A send timestamp before the previous terminal
response is unsupported. The SendMessage call links to the existing child; its
wrapper remains Raw while the delegated prompt appears in the reader.

An ordinary foreground `Agent` call with `resume: <agent-storage-id>` can then
continue that background child, including after the parent CLI restarts. Its
native `afterId`/`lastId` receipt and plain child prompt must match the same history
and UUID. This differs from `run_in_background: true` combined with `resume`,
which is outside the supported profile.

Two observed root inbox records are framework context: reactivation after a
proven follow-up and successful completion of a known member. Exact native
metadata and message templates are required. Their original records stay Raw;
they create no human Event or invented usage. Native assistant responses to
these notifications remain visible. Unknown senders, arbitrary inbox contents,
failed/canceled notification templates and ambiguous member names retain the
whole previous publication with a diagnostic. Team mailboxes are never read.

The native sequence contains one background launch, one serial SendMessage,
two framework notices and one foreground resume: two Threads, 24 Events and
ten usage records (100,306 input, 801 output, 74,880 cached input, already included
in input). Three child turns share their storage ID and internal UUID; all three
parent calls open that same Thread. Earlier Event identities remain stable.

Named teams, generic inbox/peer messages, broadcasts, overlapping or batched
follow-ups, background launches inside children, delegation by a background child,
team-disabled foreground fallback, fork/compaction inside a background child,
and forks containing background children remain unsupported. Ordinary parent resume and
additional one-shot launches remain covered. A completed assistant turn is a
snapshot frontier, not a claim that the native member cannot receive more work.

## Compaction with retained history

Native manual `/compact` and the tested engineering `pre-message-auto` path append
to the source file; they do not remove its original transcript. The Adapter keeps
that transcript and its Event identities, follows validated compaction links, and
continues in the same Session and Project. A fork can copy this compacted history
without requiring the original file.

| Native compaction record | Canonical | Raw |
| --- | --- | --- |
| `agent: compact` user command | Original `/compact` input from the text block’s `providerData.content` | Full expanded internal prompt and original command |
| Compact reasoning and completed assistant summary | Native thought and assistant text in the explicit compact turn | Full records, flags and normalized model usage |
| `pre-message-auto` user context with `isCompacted: true`, `isCompactInternal: true`, `isSummary: false` | No fabricated user turn; its `logicalParentId` must point to the preceding record | Complete `<cb_summary>` context and link |
| Ordinary messages after either boundary | Existing user/assistant mapping, retaining the full earlier transcript | Same source records |

The manual command must have its original input and a completed summary before
an open view can escape. An interrupted or unfinished compact run preserves the
previous publication and emits a source diagnostic. The automatic context record
must have the tested native flags and complete wrapper; arbitrary logical parents,
missing original prefixes and foreign identities remain unsupported. When Raw is
off, internal context is omitted completely while conversation updates continue.

The controlled sequence has four actual model responses, including the manual
summary: 20,757 input, 1,079 output and 6,656 cached-input tokens. Engineering
pre-message compaction itself has no model-response usage record, so the Adapter
does not invent one. Copied fork usage retains the historical meaning described
above. Context-only changes update Raw independently; response-loss recovery uses
the frozen journal even after source deletion.

This pre-message evidence does not establish its automatic LLM-summary variant
(`isSummary: true`), content pruning, rewind, `/clear`, `/branch`, or manual/pre-message
compaction inside children. The next section covers the distinct emergency path.

## Completed emergency compaction

The native `MaxToken` strategy appends an `emergency-auto` user context with
`isSummary: true`, `isCompacted: true`, `isCompactInternal: true` and `skipRun: false`.
It wraps the generated summary in `conversation_history_summary`. A second
internal user record requests continuation. Both use `logicalParentId` to extend
the complete stored transcript. The original messages and tool results remain.

The Adapter admits the observed completed sequence in an ordinary root or a
foreground Agent child. Both internal records are Raw-only. Their exact flags,
wrappers, continuation text and parent chain must match; the following real
assistant response must complete before the new view is exposed. A child
continuation includes its current delegated prompt, truncated by the native
200-code-unit rule. It stays in the same delegated turn, so neither internal
input becomes a new parent call or a human turn. Native thoughts can quote these
instructions; those actual thoughts remain visible and searchable. Unknown or incomplete sequences
preserve the complete previous family and produce a source diagnostic.

The controlled corpus includes root emergency compaction, child emergency
compaction during Read, and ordinary Agent resume afterward. All four parent
calls link to the same child storage ID and internal UUID. Its two Threads have
38 Events and 15 stored model-response usage samples: 151,085 input, 1,795 output,
75,840 cached input (already included in input). The summary generator's separate
one-time model call does not persist normalized response usage in these JSONL
records; the Adapter does not invent that missing measurement.

The native Read first rejects a request above its token limit. Later successful
reads spill large output into separate files; their recorded placeholders remain
visible and mark capture partial. The Adapter does not read those spill files.
These are native tool outcomes, not inferred content loss caused by compaction.

Emergency compaction in forks or background children, manual/pre-message child
compaction and other pruning/rewind paths remain unsupported. Their membership
and continuation behavior need separate evidence.


## Consistency, bounds and recovery

Source-capture was selected over the legacy paged observation runtime because
source interpretation may require a complete target; filenames alone do not
prove immutable message history. The existing Host Interface hides replacement,
comparison and recovery. The Adapter adds only provider reading/projection.

An open reads at most 16 MiB across the root, referenced children and sidecar
metadata. It validates complete UTF-8 records and rechecks every member’s
inode/size/modification/change stamps and metadata after the final member read
before exposing a view. Record, Thread and duration budgets cover the complete family. Concurrent source changes or an unfinished final line
produce a retryable-source situation with diagnostics; no partial target is
published. The source handle is closed before the first projection page.
All pages then come from that frozen bounded snapshot, including after source
changes or deletion. Close/cancellation releases it.

Discovery admits 10,000 entries. Projection snapshot bytes are capped at 64 MiB.
The Host independently bounds record size/count, Events/usage, pages, duration,
journal capacity and remote admission. See the [current default limits](../architecture/adr/0076-source-collection-release-admission.md).
This implementation rescans directories and reads a bounded full Session on
comparison. Fork discovery also reads the bounded snapshot to find the original
fork-owned record. It does not promise efficient processing of unbounded archives.
Oversized or unsupported sources retain previously captured content and progress.

With Raw off, projected frames retain no full source JSON. Re-enabling can archive
a fresh source observation without altering unchanged Canonical provenance.
Activation and Raw response loss recover independently from frozen journal data,
including after source deletion. Preserve the entire ATAPE_HOME; reinstalling or
resetting progress is not a repair for unsupported source semantics. Inspect
**Project → Sync details** in the `atape` console for source health.

## Verification and delivery status

The [fixture record](../../adapters/codebuddy/src/fixtures/README.md) states exact
native provenance and synthetic coverage. Relevant verification commands:

- `pnpm --filter @atape/adapter-codebuddy typecheck`
- `pnpm --filter @atape/adapter-codebuddy test`
- `pnpm --filter @atape/adapter-codebuddy verify:package`
- `pnpm test:codebuddy-contract` for installed CLI/Adapter, authenticated HTTP,
  PostgreSQL, reader/Search, Raw policy and recovery.
- `pnpm test:release` includes the exact CodeBuddy release artifact and Tools.

Local verification on 2026-09-13 (macOS arm64) passed Adapter typechecks and
103 runtime tests, independent tarball installation, the installed CLI/HTTP/PostgreSQL
contract, and the shared PostgreSQL/CodeBuddy/Grok/Kimi/OpenCode contract suite. Following the single-entry CLI change,
installation and selection use the console’s application Modules; initial collection
and replacement collection run in the actual installed background executable.
Fault injection and bounded recovery cycles use the source Node Host. Release packaging,
CLI terminal behavior, Tools selection and relevant application/CLI regressions
were also checked. The actual Web reader was opened against the controlled
HTTP test Server: three native turns, two thoughts, both tool outcomes and final
marker matched the fixture. The fork contract additionally verifies cross-directory
attribution, installed background collection and resume, independent reader/Search
results, exact historical usage, sidecar Raw provenance and recovery after both
history and metadata deletion. Browser acceptance of the recovered fork verified
all six turns, including the copied tools, nested fork and continued reply, in
its independent Project. The compaction contract verifies manual command recovery,
retained prefix identity, automatic-context exclusion from Reader/Search, exact
usage, Raw off/on and context-only Raw recovery after source deletion. Browser
acceptance verified its four real user turns, the recovered `/compact` command,
native summary and continued reply, with no extra automatic-context turn. This
is local acceptance, not a staging attestation.

The family contract additionally checks actual installed background collection
through initial delegation, resume, nesting, parent compaction and a built-in
Agent. It checks original Project ownership despite foreign child CWD, stable
child prefixes and links, per-Thread reader pagination and Search anchors, exact
usage ownership and child Raw provenance. Incomplete/missing children retain the
whole old target; Raw off/on preserves Canonical progress, and lost activation
recovers every frozen member after all five source files are deleted. Browser
acceptance opened the resumed child with its recovered content and followed
root → intermediate child → leaf, confirming the three-level path and native
leaf user/assistant messages in the existing side panel. The shared HTTP fixture
advances only completed CodeBuddy reservation expiry before running the next
Provider, preserving the deployment example’s finite per-User quota and verifying
that expiry leaves the selected family readable.

The background contract verifies actual installed collection of the first launch,
completion of a second child and ordinary parent resume, including foreign child
CWD, stable earlier Events and per-Thread usage. It checks Reader links and paths,
child Search anchors, exact Raw wrapper/UUID provenance, pending or missing child
preservation, Raw off/on and recovery from a lost activation response after all
three source files are deleted. Completed foreground and background fixture
groups expire only their own test User's CodeBuddy reservations, so the expanded
suite stays isolated without changing production admission limits. Browser
acceptance opened both background children from their parent: the first showed
the recovered frozen reply, and the second showed the delegated prompt,
SendMessage call/result and native final reply under the two-level Thread path.
The parent retained exactly its three real user turns.

The continuation contract replays the four native boundaries through the installed
CLI: initial launch, completed SendMessage, framework notices and foreground
resume. It verifies one stable child, exact earlier prefixes, three real parent
turns, Search anchors, ten per-Thread usage samples and native wrapper/UUID Raw
provenance. A pending child or mismatched delivery preserves every old member.
Raw off/on continues Canonical; loss of a framework-only Raw upload response
recovers after deletion of both source files without changing the selected head
or Event provenance. Lost activation similarly recovers the frozen three-turn
child after source deletion. Framework notices remain archived and absent from
Search. Browser acceptance opened all three parent links into the same child
panel, verified its three delegated turns and recovered final reply, and confirmed
that the root has only its three real user turns with no framework-notification
turns. The shared PostgreSQL/OpenCode suite also passed.

The emergency contract replays initial delegation, root compaction, foreground
child compaction and another child resume through the installed CLI. It verifies
two stable Threads, 38 Events and 15 per-Thread usage samples, with all four
parent links opening the same child. Pending or invalid summary/continue pairs
preserve the complete old family. Raw off/on, Raw-only edits and lost upload or
activation responses recover after both source files are deleted; internal
context changes do not rewrite Canonical Events or enter Search. Browser
acceptance verified four real turns in each Thread, the failed Read and both
successful spilled Read results, the two-level Thread path, and the recovered
final child reply. Actual assistant thoughts remain visible, including native
references to compaction. The partial capture status reflects the native external
output placeholders. Adapter/CLI typechecks, 103 runtime tests, independent
package installation and the full PostgreSQL/CodeBuddy/Grok/Kimi/OpenCode suite passed.

The copied-foreground-fork contract verifies four Threads, 30 Events and 13 usage
samples through the installed CLI, with original root JSONL absent and copied
CWDs naming another configured Project. Growth of the original middle/leaf files
leaves the fork head, Events and Raw unchanged; incomplete or mismatched selected
children preserve the old family. Raw off/on, Raw-only response loss and lost
activation recover after all five source files are deleted. Search opens the
recovered leaf under its three-level path and excludes later original descendants.
Browser acceptance on 2026-09-14 verified the five root turns and followed root →
copied middle → copied leaf, with only the original delegated turn in each nested
Thread and the recovered leaf reply present. Adapter/CLI typechecks, 126 runtime
tests, independent tarball installation and documentation/architecture checks
passed locally; this is not staging or publication evidence.

The new-foreground-fork contract verifies both native child directory forms and
new nested descendants through the installed CLI: five Threads, 31 Events and
12 usage records with exact counters and per-Thread ownership. Copied seed growth
changes no selected content; incomplete or invalid new children preserve the old
fork. Raw off/on and independent Raw/activation response loss recover after all
six selected source files are deleted, with original root JSONL absent throughout.
Search resolves the recovered new leaf under its three-level path and excludes
the original child's later turn. Browser acceptance on 2026-09-14 verified four
root turns, the first new child, the new parent/leaf path, their thoughts and
responses, and the frozen leaf marker. All 137 runtime tests, Adapter/CLI
typechecks, isolated tarball installation, documentation/architecture checks and
the installed HTTP/PostgreSQL contract passed locally. This is not staging or
publication evidence.

The foreground-fork-continuation contract covers a copied child and a fork-created
child whose history spans two physical paths: three Threads, 31 Events and
13 usage records with exact counters and stable prior Event/Thread identities.
Missing continuation bytes and a native intervening original-owned turn preserve
the old target. Raw off/on and independent Raw/activation recovery use frozen
bytes after all five selected sources are deleted. Search opens the recovered
second child turn, while later original-owned content stays absent. Browser
inspection on 2026-09-14 verified five root turns, both two-turn child histories,
their thoughts/responses and the recovered marker. The nested native runtime and
installed-bundle checks additionally verify copied parent/leaf continuation with
39 Events and 17 usage records. Runtime tests total 148; Adapter/CLI typechecks,
isolated tarball and documentation/architecture checks passed locally.

Package replacement may perform one Raw admission observation when the version
length changes. The installed contract verifies no Canonical/Raw content uploads,
unchanged head/checkpoint/Event provenance and the selected replacement version.
Replacement uses a re-versioned current bundle, not an old published binary.

The package belongs to the official tool/build/release set; CI must run its own
contract explicitly. Code implementation, successful local checks, merged code,
package publication and deployed Server are separate states. This guide does not
assert that the new package is already published or deployed.

For local Web acceptance, `ATAPE_CODEBUDDY_REVIEW_FILE` can name an owner-only
scratch JSON file when running `pnpm test:codebuddy-contract`. The test pauses
for up to three minutes after foreground fork-child continuation recovery (the enclosing test
adds this review time to its normal deadline); it writes the ephemeral test
Server origin, reader identifiers and test Web cookie there. Point the Web dev
server proxy at that origin, use its HTTP-development cookie name
`atape_session_dev`, inspect the reader, then create `<file>.done` to continue.
The test removes this scratch credential file on exit. Do not commit it.
