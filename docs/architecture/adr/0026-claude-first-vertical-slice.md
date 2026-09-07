# ADR-0026: Claude first implementation slice on the existing Collector

- Status: Accepted, narrow implementation scope
- Date: 2026-09-07

## Context and decision

The user explicitly stopped expansion of the Claude validation prototypes and
requested a production vertical slice: read one real local Session, normalize it,
upload it and display it in the existing conversation page. Existing evidence is
retained, but further standalone prototype work is paused.

Use the existing bounded pull Adapter/ACP v1/Canonical/Raw Interfaces, rather
than requiring implementation of ADR-0022–0025 before the first usable slice.
This is an explicit sequencing exception to those accepted future designs, not
a claim that their atomic publication, scanner journal or v2 tool contract ships.

The first `@atape/adapter-claude` package accepts one explicitly selected JSONL
file, checks its original root CWD against the user's Project binding, and
supports bounded single-root linear histories. Git attribution compares actual
repository common-directory identity, including worktrees; it does not fuzzy
match directory names. `/cd` never changes attribution. Ambiguous graphs,
rewrites, unsupported compaction/continuation and oversized snapshots fail before
upload. Append-only growth replays stable record/block identities with a higher
snapshot revision. This deliberately avoids needing Event withdrawal on v1.

One observation includes the entire bounded Canonical snapshot and one complete
Raw snapshot segment. Raw snapshot identity includes its digest, so the current
v1 Raw reference resolves to that immutable snapshot rather than a mutable latest
generation. Snapshot finalization is not Session termination. Existing Host
redaction, transport, authentication and checkpointing remain authoritative.
Tool call/status summaries use the existing common profile; full input/output
remains Raw and makes projection fidelity partial until shared v2 ships.

The alternatives were implementing all new publication/recovery infrastructure
first (rejected by the user for this milestone), or uploading directly from a
one-off script (rejected because it bypasses the production Adapter/Collector
Seam). The chosen Interface adds no provider-specific server or view behavior.

## Limits

This is not unrestricted Claude discovery, automatic continuation, branching,
subagent/spill capture, or recovery after arbitrary source/checkpoint loss.
Existing v1 concurrent-writer and mutable-source retry limits still apply; new
fencing/guard work is deferred, not silently promised. The initial slice is
explicitly opt-in and documents its bounds. Tests target this actual Adapter and
the real Collector/Go read APIs; no new standalone validation engine is required.

## Follow-on implementation: Project discovery

The same Adapter now defaults to bounded `~/.claude/projects/*/*.jsonl` discovery,
with an alternate `ATAPE_CLAUDE_HOME` and the original optional single-file override.
No new Module Interface or server behavior is introduced. Metadata-first discovery
uses original CWD attribution, never encoded directory names, and excludes nested
subagent files and symlinks. The selected linear-history and snapshot limits remain.

Per-Session committed prefixes live in a versioned opaque Host checkpoint, not an
Adapter-local database. A page publishes one changed Session; scanning resumes after
that Session for fairness. Single-file checkpoints migrate without a reset. Missing
sources retain progress; duplicate source identities fail closed. The bounded
16,000-byte checkpoint and 10,000-entry scan cap fail explicitly rather than evicting
history. This favors Locality and the existing checkpoint Seam over introducing a
second journal, while accepting limited archive capacity for this implementation.
