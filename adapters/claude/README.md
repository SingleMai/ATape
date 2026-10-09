# Claude Code Adapter

Capture Project-scoped Claude Code JSONL through ATape's normal Collector,
shared ACP profile, Server and conversation reader.

```sh
pnpm --filter @atape/adapter-claude build
pnpm atape
```

In **Tools and updates**, add Claude to the global tool selection and review the
affected Projects. Installing the package alone does not enable collection.
For a local build, install `./adapters/claude` through Integration maintenance.
For an offline packaged installation, `pnpm pack:release` writes matching CLI and
Adapter tarballs plus `SHA256SUMS` to `release/`; install the CLI, then choose the
Claude tarball in Integration maintenance. These commands do not publish or deploy.
The Project must already be configured and authenticated.

[ADR-0097](../../docs/architecture/adr/0097-claude-compaction-continuity.md) defines
generic compaction continuity and recovery. The [current guide](../../docs/adapters/claude.md)
owns actual behavior and verification; retained native evidence records the scope
of the earlier implementation.

## Sources and attribution

Discovery reads `~/.claude/projects/*/*.jsonl`. `ATAPE_CLAUDE_HOME` selects an
absolute alternate Claude configuration directory; `ATAPE_CLAUDE_SESSION_FILE`
selects an absolute root file for diagnostics. The first UUID record's original
CWD determines Project attribution, including linked worktrees and independent
Git clones through `atape.git-attribution.v1`. Later CWD changes and encoded
directory names do not reassign a Session. Symlinked files/directories are not
traversed. An unavailable origin without retained evidence is diagnosed locally.

## Supported now

The Implementation replaces per-round templates with one source-identity
normalizer behind the existing paged collect Interface:

- Actual user/assistant text, tool calls and own-call results retain source UUID /
  physical block-slot Event anchors. An open response batch authorizes its own
  result edges; historical known parents cannot authorize stale branches.
- Manual and automatic compaction use declared boundary/summary relationships.
  Identical UUID copies preserve the whole decoded original, including unknown
  fields, with only an absent slug addition or an unchanged existing slug.
  Copies, summaries, file context and admitted command/synthetic controls stay
  Raw-only. No round count, tool count, ordinary-gap shape or predicted file count
  governs continuation. Each subsequent genuine record resumes ordinary projection.
- Split assistant records update one real API usage identity at its latest
  original revision; replay adds no usage revision. Source compaction counters
  and synthetic responses do not become billable usage. Missing native summary
  API records mean that request's actual usage is unavailable.
- Complete source records and reducer state survive EOF, partial appends, small
  pages, fresh runtimes and exact retries. Canonical and Raw receipts remain
  independent, including Raw-off capture followed by retained-source backfill.
- A correlated completed foreground Agent/Task receipt can admit its direct
  child at `<sessionId>/subagents/agent-<agentId>.jsonl`. Exact tool/assistant IDs,
  Agent ID, root Session/CWD and child sidechain ownership must agree. The child
  becomes `claude-agent:<agentId>` under root with separate Canonical/Raw progress.
  The same compaction rule applies within an admitted child Thread.
  `.meta.json` is not read and finding a child file alone is not admission.

Shared Input/Output details are collapsed and escaped, with Host redaction before
network requests. Unknown content/nonempty thinking remain captured Raw;
tool-bearing projection retains partial fidelity. Search covers actual message
bodies and excludes tool summaries/full values. Root, Thread and Raw identities
stay stable through supported upgrades and source deletion.

## Explicit limits

Source records fit 16 MiB including LF; text fragments fit 256 KiB. Requested
Canonical/Raw budgets still apply per record, including family headers and usage.
Insufficient remaining capacity defers a record; impossible fresh capacity fails
with a typed limit. Shared tool values retain at most 64 KiB, depth 32 and 10,000
nodes; larger values require captured Raw. These are separate policies.

Discovery checks up to 256 records / 64 MiB for original identity and admits at most
10,000 directory entries. Opaque metadata cursors compress above 16,000 bytes,
with 1 MiB encoded / 16 MiB decoded bounds. There is no historical 64-LF window or
whole-replay observation requirement in the Implementation. Resource limits still
bound large archives. Cold prefix reconstruction is O(committed source) I/O/hash,
is cancellable and does not establish an atomic snapshot or an RSS guarantee.

Duplicate identities with different decoded data, mixed Thread/Session ownership,
changed/truncated captured prefixes and invalid control/parent links fail.
Malformed cursor state is never reset silently. Fork/rewind/Active Path replacement,
cross-file ownership, nested/background children, child forks and spill
collection remain separate work. The native corpus comes from Claude Code 2.1.263;
it does not promise compatibility with every version or source shape.

## Partial collection and recovery

Project → Sync details shows bounded, redacted local source diagnostics. Healthy
Sessions continue; failed Sessions retain progress and retry. Up to 32 diagnostics
are reported with a truncation flag. Duplicate source Session identities are
isolated. Repair malformed data or restore its exact captured prefix; deleting
checkpoints cannot repair source semantics. Global capacity/corrupt cursor/Host
failures still fail the job.

Preserve the complete CLI state directory and upgrade through Tools and updates.
Private normalization version 1 is separate from Event projection 4. Valid older
single-file/discovery/z3 opaque checkpoints reconstruct committed source context
without replaying Events, changing usage/Raw identity or dropping active state.
Actual Event fragments and deferred usage remain on their original record.
Independent Raw receipts can be ahead of the supplied parser input. Unknown
schemas and inconsistent old state fail explicitly. See
[recovery](../../docs/adapters/claude.md#recovery-and-upgrades).

An unsupported tail can block requested Raw backfill of an older prefix. Existing
receipts remain valid; enabling Raw does not bypass that conflict. Legacy
concurrent-writer and lost-checkpoint limits remain; use one Collector and retain
its state. The receiving Server must accept `atape.acp-centered.v2` before a CLI
emitting bounded tool details is used. Package publication and Server deployment
require their own authorization.

## Source evidence and verification

The [fixture ledgers](../../docs/adapters/claude.md#verification-and-remaining-work)
record controlled native foreground, manual, text-auto, tool replay, reverse-result,
repeated Read and larger-file source facts. Their round counts validate reusable
rules rather than define supported feature counts. Paths are substituted; some
older runs inherited HOME without recording it. Generated repeated sequences are
behavior tests, not additional native invocations. Mock counters are not billing.

Public-factory and installed-package checks cover repeatable compaction and
independent Raw backfill; 505 genuine previous-main opaque inputs preserve
Events, latest usage and Raw identity through upgrade. The guide records the
source/bundle hashes and the passed authenticated Collector acceptance: 187
independently restarted managed-daemon runs with Reader, usage, Search and Raw
assertions. Native acquisition alone does not establish
publication, deployment, browser staging or compatibility with every historical
published package. All earlier checks retain their recorded scope.
