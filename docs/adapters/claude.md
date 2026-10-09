# Claude Code Adapter

The Claude Adapter discovers Project-scoped JSONL history and delivers it through
ATape's paged Collector. The Host owns attribution, redaction, Canonical/Raw
uploads and checkpoint commits. Claude keeps legacy batch capture.

[ADR-0097](../architecture/adr/0097-claude-compaction-continuity.md) replaces
sample-specific compaction admission with source-identity continuity. The
Implementation uses the same rule for every compaction; round counts in tests
are input data, not supported feature counts.

## Install and enable

Use **Tools and updates** to add Claude to the existing global tool selection,
reviewing its effect on all connected Projects. Package installation alone does
not authorize capture. See the [package README](../../adapters/claude/README.md)
for build/install commands and the [CLI guide](../cli/setup-and-adapters.md)
for Project setup and tool management.

## Sources and supported history

Discovery reads `~/.claude/projects/*/*.jsonl`. `ATAPE_CLAUDE_HOME` selects an
absolute alternate configuration directory; `ATAPE_CLAUDE_SESSION_FILE` selects
an absolute single root file for diagnostics. Symlinks are not traversed.
Discovery inspects at most 256 records / 64 MiB per file to find its first UUID
record. That record's original CWD establishes attribution; directory names and
later directory changes do not reassign a Session.

Git Projects use shared Host attribution across worktrees and independent clones.
Foreign repositories are excluded; missing original directories without retained
evidence produce an attribution diagnostic. Both CLI and Adapter require
`atape.git-attribution.v1`. Ordinary-directory matching remains path-scoped.

Root histories use complete UTF-8 JSONL records and append-only source prefixes.
The normalizer separates original conversation records, identity-preserving
copies and provider controls before producing Canonical data. Actual user and
assistant text, tool calls and correlated results use the shared ACP reader.
Source UUID plus physical block-slot coordinates keep Event and message anchors
stable; split records from one assistant API response remain distinct Events.

Ordinary parent edges must advance the current leaf. Tool-result edges must name
their own call in the currently open response batch; membership in all historical
UUIDs or tool IDs cannot authorize an old parent. Tool count and result arrival
order are data rather than a fixed two-Read layout. Source order is preserved.
Conversation identity, role and Thread ownership must agree before either Events
or usage are admitted. UUID-less bookkeeping produces no conversation or usage.

The shared reader displays bounded Input/Output as collapsed, escaped text/JSON.
Unknown content and nonempty thinking remain Raw when captured; tool-bearing
projections retain partial fidelity. [Search](../api/project-search.md) matches
actual user/assistant message bodies and excludes tool summaries and full values.
The retained native corpus is Claude Code 2.1.263 evidence, not a blanket promise
for every Claude version or source topology.

## Compaction and continuation

One reducer handles automatic and manual compaction in each selected Thread without counting rounds,
requiring a particular ordinary bridge, or predicting a file count. Repeated
compaction returns to ordinary capture through the same rules each time. Source
identity and prefix integrity remain required.

A repeated UUID is context replay only when its complete decoded original agrees,
including unknown fields. The permitted metadata difference is adding a slug
when absent; an existing slug stays unchanged. Object key order is irrelevant;
array order and values remain exact. Copies commit as individual Raw-only
records and add no Events or later usage revisions. A changed copy is a source
conflict. Original bytes and all physical copies remain in Raw under the user's
capture policy.

A fresh `compact_boundary` must link its logical parent to the current leaf.
Its declared retained UUIDs, head/tail and fresh summary anchor are checked
against authenticated source records. Retained records and replayed records are
separate concepts; their lengths need not match. The required summary must have
the declared identity, boundary parent and compact-summary flags. Boundary and
summary remain Raw-only.

Typed file attachments, metadata, local-command envelopes and synthetic
scaffolding during continuation remain Raw-only after their Thread identity and
control edges are checked. They do not become user messages, tool executions or
billable assistant responses. The Adapter neither opens referenced files nor
infers a mandatory list of files from an earlier sampled turn. The next genuine
message or tool record resumes ordinary Event/usage projection after its graph
edge is validated.

Each complete record commits with the source prefix and private reducer state.
EOF or an incomplete next line preserves pending context without inventing a
message or a busy continuation loop. Small observations can stop at a copy,
boundary, summary or control record and resume in a fresh runtime. A conflicting
complete record retains the preceding accepted progress and produces a source
diagnostic. This additive path preserves pre-compaction conversation; fork,
rewind and Active Path replacement require a separate publication decision.

Only recorded real assistant API responses contribute usage, upserted by API ID
at the latest original revision. Split response records do not sum the same API
counters twice, and replayed copies do not create a new revision. The native
compaction request has no assistant response record in JSONL, so its actual usage
cannot be recovered. `compactMetadata` counts are context bookkeeping. Mock
counters in retained fixtures establish accounting behavior, not billing.

## Foreground subagents

[ADR-0087](../architecture/adr/0087-claude-foreground-subagents.md) selects ordinary
completed foreground children. A root `Agent` or `Task` result must declare
`toolUseResult.status: "completed"` and `agentId`, be non-asynchronous and
non-error, and match the invocation's tool-use ID and exact
`sourceToolAssistantUUID`. The selected source is
`<root-file-directory>/<sessionId>/subagents/agent-<agentId>.jsonl`.
Its first UUID record must share the root Session ID and original CWD, declare
the selected Agent ID and `isSidechain: true`. Finding a file in that directory
alone does not authorize capture; the `.meta.json` sidecar is not read.

The child becomes `claude-agent:<agentId>` under `root`, linked from the actual
parent tool-result Event. Each stream has independent prefix, Canonical and Raw
progress. Child CWD changes do not reassign the family. Admitted children rotate
between pages after the root catches up; sustained root backlog can delay them.
Missing captured child files retain their history/checkpoints. Unproved children
are not selected from directory contents.

[ADR-0098](../architecture/adr/0098-claude-current-thread-continuity.md) separates
current Thread capture from child admission. A valid Agent/Task invocation or
receipt remains a tool Event in its current Thread, including asynchronous,
noncompleted, error and nested delegation. Its ordinary following messages,
real assistant usage and eligible Raw continue. An actual Agent/Task receipt
without an admitted child produces an `unsupported` diagnostic for the current
source, while publishing no child link/header and reading no proposed child
file. Pending calls alone do not produce that diagnostic. Unsafe locators,
missing ownership evidence and multi-Event receipts also remain unlinked.

Diagnostics are deduplicated per source/reason and rebuilt from authenticated
committed source bytes, including idle collection after restart, even when a
root page or another child returns before the affected child's normal turn.
Only its already acknowledged prefix
is inspected for this visibility; pending bytes and unproved children are not
collected. Diagnostics indicate
partial relationship capture even when the current Thread is caught up. Already
pinned ownership contradictions, malformed records, wrong Thread/Session
identity, stale parent/call correlation and changed prefixes still fail before
ACK. Raw-only replay copies create neither relationships nor new diagnostics.

The same compaction reducer applies within a selected child Thread. Generated
checks cover child continuation; the recorded foreground fixture establishes only
its ordinary Agent/Read relationship. Capture of nested/background or interrupted
child histories, child forks and spill collection remains outside this
relationship. Capturing the current Thread around an unlinked receipt does not
establish capture of that proposed child.

## Bounds and Raw policy

The parser admits records up to 16 MiB including LF; text fragments are bounded
at 256 KiB. Requested Canonical and Raw observation budgets still apply to each
record. An Event or usage item that cannot fit a fresh reserved Canonical page
fails with a source limit; insufficient remaining capacity defers it. Family
Thread headers count toward the page budget. A fragmented original does not
join committed graph evidence until all its Events and usage commit.

Shared tool details retain at most 64 KiB, depth 32 and 10,000 nodes; larger
values remain in captured Raw. This detail limit is independent of source-record
admission. Generic compaction removes historical 64-LF windows and atomic
whole-replay groups; it does not require all copies or files to fit one page.

Discovery admits at most 10,000 directory entries. Metadata cursors compress
above 16,000 bytes and retain a 1 MiB wire / 16 MiB decoded limit. These resource
bounds can still limit a large archive; unlimited compaction cycles do not imply
unlimited checkpoint capacity. Cold reconstruction costs O(committed source)
I/O/hash and is cancellable. Independently restarting every small control page
repeats that scan; many tiny pages increase total collection work. Retained serialized bytes are not an RSS guarantee.
Family diagnostics also scan the committed prefixes of admitted children that
were not visited before the current page returned, so a root page can cost
O(committed family source) work.
Same-handle prefix checks and final stat retain legacy concurrent-writer limits;
they do not create an atomic filesystem snapshot.

The Adapter declares `atape.raw-capture.v1`. With Raw disabled, Canonical continues
without advancing Raw receipts. Re-enabling Raw backfills retained source bytes
under the [capture policy](../cli/raw-capture.md). Raw offsets can advance
independently while the Host retains an older parser cursor; retries preserve
source object/generation and exact bytes, including UTF-8 transport boundaries.
Source deletion retains already captured history and receipts.

An unsupported appended record can stop parsing before requested Raw backfill
of an older eligible prefix. Existing receipts remain valid; enabling Raw does
not bypass a source conflict. Complete physical evidence is available only when
Raw was actually captured.

## Recovery and upgrades

Preserve the complete CLI state directory. A package-version change alone does
not reset capture: the Adapter validates cursor schema, original ownership and
committed-prefix bytes. Single-file v1, discovery v2 and compressed `z3` cursors
retain their supported recovery. Private normalization version 1 is separate
from Event projection revision 4.

Older acknowledged source context is reconstructed before continuation. Its
leaf, calls and pending controls must agree with the source; existing Event
fragments and deferred usage remain tied to their actual next original record.
Upgrades preserve committed Events, byte-based revisions, tool anchors and Raw
identity rather than replaying or deleting checkpoints. Recognized corrupt
state, changed/truncated prefixes and unknown schemas fail explicitly. Genuine
older opaque checkpoints provide compatibility evidence; re-versioning a current
bundle or deleting private fields does not.

Project → Sync details reports bounded, redacted local source diagnostics.
Healthy Sessions continue; failed Sessions retain progress and retry next cycle.
Reports retain up to 32 diagnostics with a truncation flag. Duplicate source
Session identities are isolated rather than merged. Repair malformed data or
restore the exact captured prefix to resume; resetting a cursor cannot correct
source semantics. Global discovery/cursor limits and corrupt checkpoints still
fail the job.

The receiving Server must accept `atape.acp-centered.v2` before a CLI emitting
bounded tool details is used. Existing v1 requests remain accepted without those
details. See the [release guide](../releasing.md); merging, publishing packages
and deploying a Server are separate actions.

## Verification and remaining work

All 184 public `createAtapeAdapter`/`collect` tests pass. The installed package
check and those suites exercise all twelve retained native compaction scenarios and explicitly generated
1/2/3/10/100-cycle histories. Generated coverage varies ordinary gaps, tools,
result order, context files and the first real continuation. It checks every
complete-line and partial-EOF cut, exact retry after reopening, original usage
revisions, independent Raw backfill, child ownership, malformed copies/controls,
source repair and parser/checkpoint capacity. Deep unknown JSON and changed values
are compared through the same caller Interface. These are behavior tests, not
new native captures. The 36 generated unlinked-delegation cases add missing,
asynchronous, noncompleted, error, unsafe and multi-Event receipt checks;
current-Thread continuation, partial LF, one-Event pages, Raw-off/backfill and
family diagnostics after root or sibling pages. Real source/correlation and
pinned ownership conflicts remain failures. No new native child lifecycle
acquisition is claimed.

The candidate source SHA-256 is
`597c849f44ffd83f628d89b59a178e6511e7db758f4ddf3fa01377017b796b4e`;
its built bundle is
`0e029ba7427ea322975ae827b201451f998199e638e3a7b5c6291e5d16487733`.
The installed tarball check covers native append/restart, generated 1/3/100 mixed
cycles, six generated unlinked-receipt cases, cold idle/retry and Raw-off capture
followed by bounded backfill. The shared Codex package verifier also passes.

Genuine compatibility inputs for this candidate were produced by previous main
`c661ad01aaa4202f62abf9a660f0032fc0a16d8d`, source
`0748f8cfb75514e80d255c59b045a69cde1779f0bf68eee0664383eb4970da66`,
bundle `910afd6c3322a6e0db0e4b09293a1c828a047ce6f5f371bf164db3330c13bb43`.
All six generated continuations reproduce the old blockage. Their 65 genuine
opaque inputs, including ten actual Event-only/deferred-usage inputs and
independent old Raw receipts, resume on this candidate through fresh runtimes
and exact retries. They preserve complete original Event vectors, latest usage
objects and contiguous acknowledged Raw suffix/object/generation. Raw-off inputs
also retain Canonical identity through later backfill. No private checkpoint
fields were rewritten.

The earlier compaction increment at `c661ad0` separately verified 505 genuine
inputs produced by `de57001ed98d58a9048c5e8c0263e510dd8a731a` (481 native LF
checkpoints and 24 Event-only inputs). That recorded compatibility evidence
belongs to its tested candidate; the current increment's 65 upgrades and
retained native regression suites establish the checks run here.

All four Collector/Server E2E checks pass. The final source and bundle pass the
authenticated HTTP/PostgreSQL contract with 197 independently restarted
managed-Collector stages. Its additional ten generated stages cover
root and selected-child ordinary continuation around unlinked receipts, partial
LF, persistent family diagnostics, Reader/tool/Search anchors, latest-once usage,
unproved child exclusion and independent Raw backfill. The required contract
actually ran and passed without skipping (305.39 seconds for its subtest). The
local final log SHA-256 is
`7aac9ca86cd6980f6103c4db4236d4341f9cd371b255755bae4b55439fbe9dc5`.
The earlier increment's 187-stage pass is not this candidate's acceptance.
Package publication and Server deployment are separate actions.

Native source facts, acquisition controls, snapshot/cut hashes and request/usage
limits are owned by the fixture records:

| Source evidence | Recorded scope |
| --- | --- |
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

Fork/rewind/Active Path replacement, cross-file Session adoption, broader child
relationships and spill collection remain separate topology work. Legacy
concurrent-writer, lost-checkpoint and pending delivery after source loss limits
remain. Provider-specific browser staging and upgrades from historical published
binaries are unverified. No package publication or Server deployment is claimed.
