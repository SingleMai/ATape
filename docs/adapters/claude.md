# Claude Code Adapter

Claude captures the source-indicated current conversation through
`atape.source-capture.v2`. The Adapter interprets Claude's graph; the shared Host
owns attribution, redaction, durable preparation and delivery. The Server selects
a complete Canonical publication atomically for Reader, Search and Overview.
[ADR-0101](../architecture/adr/0101-claude-active-path-and-legacy-adoption.md)
records this design and explicit migration of existing legacy Sessions.

## Install and enable

Use **Tools and updates** to add Claude to the global tool selection. Installation
alone does not enable collection. See the [package README](../../adapters/claude/README.md)
and [CLI setup guide](../cli/setup-and-adapters.md). Preserve the complete CLI state
directory when upgrading. A compatible Host and a Server advertising publication
v2 targets and legacy adoption are required. Older Hosts reject the new manifest.
Merging, package publication and Server deployment are separate actions.

## Sources and supported history

Discovery reads `~/.claude/projects/*/*.jsonl`. `ATAPE_CLAUDE_HOME` selects an
absolute alternate configuration directory; `ATAPE_CLAUDE_SESSION_FILE` selects
one absolute root file for diagnostics. Symlinks are not traversed. The first
UUID record's original CWD establishes attribution; directory names and later CWD
changes do not reassign a Session. Discovery inspects at most 256 records / 64 MiB
per file for that identity and admits at most 10,000 directory entries.

Git Projects use shared `atape.git-attribution.v1` attribution across worktrees
and independent clones. Foreign repositories are excluded. An unavailable origin
without retained evidence is diagnosed. Ordinary-directory matching is path-scoped.
Duplicate source Session identities are isolated rather than merged.

The bounded complete-source index separates original records, identical copies
and provider controls. Actual user/assistant text, recorded assistant thinking,
tool calls and correlated results use the shared ACP reader. Source UUID and
physical block-slot coordinates preserve Event/message anchors. Split records
from one assistant API response remain distinct Events; latest original counters
update one usage identity for that API response rather than being summed twice.
Only recorded real assistant API responses contribute usage. Compaction metadata
and synthetic responses are not billable samples; absent native summary API
records cannot establish that request's actual usage.

Nonempty recorded thinking appears in collapsed Reader Activity. UTF-8 fragments
share one physical block's ACP `messageId` and retain original part indices.
Empty or whitespace-only blocks produce no Event. A blank fragment is Raw-only;
remaining meaningful fragments preserve exact text with partial fidelity. Signatures,
opaque redacted thinking and unknown content remain Raw-only when captured.
Missing reasoning cannot be recovered. Tool Input/Output is collapsed, escaped
and bounded. Host redaction applies before network delivery.
[Search](../api/project-search.md) includes actual user/assistant messages and
excludes thinking and tool summaries/full values.

## Current path, rewind and compaction

The Adapter follows validated logical predecessors, including own-call tool
results and declared compaction continuity. A genuine new user turn can reconnect
to a known earlier anchor. Native explicit `last-prompt` leaf evidence also supports
rewind without a new prompt and an empty current conversation. Later descendants
advance that selection. Ordinary last-prompt bookkeeping and timestamps alone
cannot select a branch. Unknown selectors, stale tool/assistant parents and
contradictory identities fail rather than mixing incompatible paths.

Activation withdraws abandoned root Events, their usage and children whose proved
parent receipt is no longer selected. Their physical source records remain Raw
eligible. Event keys on the retained path remain stable. An empty path is a valid
complete target, retaining the original creation Origin and Session identity.

One reducer handles manual and automatic compaction without counting rounds or
predicting tool/file counts. A replayed UUID must preserve the whole decoded
original, including unknown fields; the allowed metadata difference is an added
previously absent slug or an unchanged existing slug. Object key order is irrelevant;
array order and values remain exact. Changed copies conflict. Valid copies add no
Events, relationships or usage revisions.

A fresh compact boundary's logical parent, declared retained head/tail and summary
identity must agree with authenticated records. Boundaries, summaries, validated
file context, command envelopes and synthetic scaffolding remain Raw-only. The
next genuine conversation record resumes ordinary projection. Compaction neither
resurrects an abandoned sibling path nor requires a sampled ordinary bridge.
[ADR-0097](../architecture/adr/0097-claude-compaction-continuity.md) owns the
continuity rationale. Incomplete trailing JSONL is deferred.

## Foreground subagents

A completed foreground `Agent`/`Task` result admits a direct child only when its
tool-use ID, exact `sourceToolAssistantUUID`, Agent ID and completion metadata agree.
Asynchronous and error results do not admit children. The selected source is
`<root-file-directory>/<sessionId>/subagents/agent-<agentId>.jsonl`; its first UUID
record must share the root Session/CWD and declare the Agent ID and sidechain
ownership. Finding a file alone is insufficient. `.meta.json` is not read.

The child becomes `claude-agent:<agentId>` under `root`, linked from the actual
parent tool-result Event. The same graph, thinking, usage and compaction rules
apply within it. Its current CWD cannot change family attribution.

If a previously captured child is missing or unreadable, the target retains its
previous stored membership and prefix proof with a diagnostic while valid root
capture advances. The selected root must still prove the same parent receipt;
the Server verifies retention against the base head. A never-captured failed
child creates neither an empty Thread nor a misleading link. Restoring the exact
source allows fresh capture. Changed authenticated child bytes are never acknowledged.

Current Thread capture continues around background, noncompleted, error or nested
delegation, with an `unsupported` diagnostic for an actual unlinked receipt.
Pending calls alone do not warn. These receipts do not authorize reading a child
file. Raw-enabled views may separately archive available child histories proved
by historical completed root receipts outside the current path, without selecting
their Events, usage or relationships. Diagnostics are rebuilt on idle restart and
deduplicated per source/reason.

## Bounds and Raw policy

The source parser admits complete records up to 16 MiB including LF. Default v2
source-page admission is 32 MiB; explicit caller limits still apply. The complete
plan is bounded by 20 Threads, 100,000 records, 20,000 Events and Usage samples and
120 seconds by default. Draft delivery pages remain independently bounded.
Prior Thread metadata has its own 1,000-Thread / 2 MiB bound, allowing old children
to survive a smaller current target. Text fragments fit 256 KiB; shared tool detail
fits 64 KiB, depth 32 and 10,000 nodes. These limits do not promise constant RSS.

The source checkpoint contains bounded identity and complete-LF prefix proofs,
with a 1 MiB limit. Each opened stream authenticates its prior committed prefix;
unavailable or off-path retained proofs are preserved without acknowledging
changed bytes. Planned source bytes are checked again before completion. This is a
cancellable bounded filesystem observation, not an operating-system atomic snapshot.
Changed/truncated prefixes, mixed ownership and malformed checkpoint state fail
explicitly; checkpoints are not silently reset.

Each physical JSONL record reaches the Host intact before redaction. Additional
Canonical frames use source references instead of splitting unredacted strings.
Raw is independent of selected Canonical membership and includes eligible copies,
controls and abandoned branches under the user's policy. Raw-off capture does not
acknowledge Raw delivery; later Raw-enabled capture backfills available history.

The Host's existing packed Raw format has a 3 MiB packed-object / 5 MiB wire-object
bound. A single redacted record that cannot fit produces an explicit Raw limit gap,
even if the source parser admits it. Nested redaction also has depth/node/byte
limits. Parser support for a large record therefore does not promise its full Raw
archive. Raw backfill requires source bytes; existing uploaded objects, ownership,
generations, receipts and links remain valid after source disappearance.
See [Raw capture policy](../cli/raw-capture.md).

## Recovery and upgrades

The explicit `atape.legacy-migration.v1` capability decodes this Adapter's old
single-file, discovery and compressed z3 checkpoints. Acknowledged root UUIDs are
decoded offline. For an older cursor or a partly delivered first root record that
lacks that UUID, the Adapter uses bounded source reads to verify the original
header and available prefix; unavailable or contradictory evidence is diagnosed.
The Server checks existing capture ownership/scope and binds the publication
Origin. A zero-byte old checkpoint has no historical first-record UUID/body
hash; this fallback validates current evidence without recovering that absent
proof. Committed prefix hashes remain mandatory. The shared Host never
parses provider cursor internals. Before adoption, the Adapter authenticates
acknowledged prefixes and validates old partial-page state against its old projection.
Unknown schemas and inconsistent old state fail with a diagnostic.

The Host durably freezes the installation, Project creation, exact original
checkpoint and Raw acknowledgements before remote adoption. Each frozen checkpoint
or source header is bounded at 2 MiB and charged to journal admission; attempted
freezes remain charged after a compare-and-set race. The global checkpoint
selects that immutable snapshot by digest using compare-and-set. A concurrent
legacy checkpoint update cannot substitute a different frozen baseline. Recovery
replays existing journal obligations before opening source files.

The authenticated Server adoption operation preserves Session/Thread/Event/Usage
keys and existing Raw access, fences further legacy writes and returns a version
floor plus prior Thread metadata. Ordinary reservation still rejects legacy Sessions.
Old Reader, Search and Overview membership remains selected until the first complete
new head activates. Failed preparation or delivery exposes no partial replacement.
The Host allocates new revisions above the old floor and persists source metadata
and prefix proofs with the activated capture. Later collection validates this proof
without reusing the old legacy cursor.

Sealed redacted Canonical/Raw delivery and activation reconciliation can recover
without source files, including a committed activation whose response was lost.
Unsealed preparation must reopen the source. Legacy batch capture had no durable
prepared outbox; migration cannot invent an
old unacknowledged payload. Source loss can prevent new projection or Raw backfill.
Raw-off legacy references without uploaded objects do not require recreation of
obsolete object IDs; later backfill uses the new Host-packed format.

Project → Sync details reports at most 32 bounded, redacted diagnostics with a
truncation flag. Healthy Sessions continue; failed sources retain their previous
progress and retry. Missing children retain history with a partial-capture warning.
Global capacity, corrupt cursor or Host failures can still fail the job. Repair
malformed data or restore the exact captured prefix; deleting state does not repair
source semantics.

## Verification and remaining work

Current acceptance uses the shipped factory's sourceCapture Interface, the shared
collection Interface, installed packages and authenticated HTTP/PostgreSQL.
Genuine previous-main `f6093535e92acfee47170b53c7dec7244fccf8c7` artifacts produce
legacy checkpoints; current code is not relabeled as an old package. Historical
collect tests are separate evidence and cannot substitute for current sourceCapture
acceptance. CI requires both the new native Claude contract and the historical
legacy contract to execute successfully.

Native source facts, acquisition controls, snapshot/cut hashes and request/usage
limits are owned by the fixture records:

| Source evidence | Recorded scope |
| --- | --- |
| [Rewind and continuation](../../adapters/claude/fixtures/native-rewind-2.1.263/README.md) | Hidden resume anchor and successful live rewind control; explicit empty leaf and later descendants |
| [Thinking family](../../adapters/claude/fixtures/native-thinking-2.1.263/README.md) | Four native persisted bodies; root/child same-API split records; mock signatures/usage |
| [Foreground child](../../adapters/claude/fixtures/native-foreground-child-2.1.263/README.md) | Direct completed Agent/Read family; independent root/child Raw |
| [Manual compaction](../../adapters/claude/fixtures/native-manual-compact-2.1.263/README.md) | Singleton retained tail and real continuation |
| [Manual text tail](../../adapters/claude/fixtures/native-manual-text-tail-2.1.263/README.md) | Same-response text pair; no executed Read |
| [Automatic text](../../adapters/claude/fixtures/native-auto-text-replay-rounds-2.1.263/README.md) | Three native automatic cycles in five snapshots |
| [Read pair](../../adapters/claude/fixtures/native-read-pair-2.1.263/README.md) | Two split-response layouts and own-call results |
| [Read automatic replay](../../adapters/claude/fixtures/native-auto-read-replay-2.1.263/README.md) | Six/eight first-slug copies in two Sessions |
| [Repeated single Read](../../adapters/claude/fixtures/native-repeated-auto-read-2.1.263/README.md) | Two native cycles and a prior-file injection |
| [Reverse Read pair](../../adapters/claude/fixtures/native-reversed-read-pair-2.1.263/README.md) | B/A results, replay and an ordinary continuation |
| [Repeated dual Read](../../adapters/claude/fixtures/native-repeated-dual-read-2.1.263/README.md) | Existing-slug replay, ordinary bridge and two prior files |
| [Manual Read files](../../adapters/claude/fixtures/native-manual-read-reinjection-2.1.263/README.md) | Whole receipt reinjection, controls and continuations |
| [Larger manual Read files](../../adapters/claude/fixtures/native-manual-large-read-reinjection-2.1.263/README.md) | Complete 98,304-byte Reads; exact reinjected objects |

These fixtures validate source rules; their round/tool/file counts are not
feature limits. Some older runs inherited HOME without recording it; each
ledger states its actual controls. Deterministic loopback counters and missing
summary-response records do not establish real provider cost completeness.


Cross-file Session adoption, nested/background child histories, child forks and
spill collection remain separate work. The retained source corpus is Claude Code
2.1.263 evidence, not a promise for every version or graph shape. Live-provider
browser staging and upgrades from historical published binaries remain unverified;
source-built previous-main compatibility is checked separately. This increment
does not publish packages, deploy a Server or migrate a production database.
