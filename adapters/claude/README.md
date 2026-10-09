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

[ADR-0101](../../docs/architecture/adr/0101-claude-active-path-and-legacy-adoption.md)
defines Active Path publication and explicit legacy adoption; [ADR-0097](../../docs/architecture/adr/0097-claude-compaction-continuity.md)
defines the shared compaction reducer. The [current guide](../../docs/adapters/claude.md)
owns actual behavior and verification; retained native evidence records the scope
of the earlier implementation.

## Capture behavior

The factory exposes only `atape.source-capture.v2`, with explicit
`atape.legacy-migration.v1` support for acknowledged earlier checkpoints. A compatible
Host and publication-enabled Server with v2 targets and legacy adoption are required.
Older Hosts reject this manifest instead of treating it as legacy capture.

The Adapter selects the current root path from validated native graph/leaf evidence.
Rewind withdraws abandoned Canonical Events, usage and child membership when the
complete target activates. Eligible physical records remain Raw under the user's
policy. Manual and automatic compaction share one continuity reducer without a
round/tool/file count. Recorded thinking, tools, latest original API usage and
proved completed direct foreground children use the shared reader. A missing
captured child can retain prior stored history with a diagnostic while the root
advances. Raw-enabled capture also archives available historical child sources
proved by completed root receipts outside the selected path.

Discovery uses `~/.claude/projects/*/*.jsonl`. `ATAPE_CLAUDE_HOME` selects an absolute
alternate configuration directory; `ATAPE_CLAUDE_SESSION_FILE` selects an absolute
root file for diagnostics. The first UUID record's original CWD establishes Project
attribution, including Git worktrees and independent clones. Symlinks are not followed.

Preserve the complete CLI state directory on upgrade. Explicit migration validates
old prefixes and opaque state before adopting the same Session. Legacy Reader,
Search and Overview remain selected until complete activation; existing Raw access
survives. Frozen new delivery can recover without source files. Lost source bytes
still prevent fresh projection or backfill.

## Limits and verification

Source records fit 16 MiB including LF; text fragments fit 256 KiB. Full-source,
page, Thread, record, target and deadline bounds remain explicit. Each physical
Raw record reaches the Host intact before redaction. A single redacted record
exceeding the existing 3 MiB packed Raw object produces an explicit Raw limit gap.
Nested/background child histories, cross-file adoption, child forks and spill
collection remain outside the supported profile.

The [current guide](../../docs/adapters/claude.md) owns complete behavior, bounds,
recovery, remaining work and native fixture ledgers. Current tests use the shipped
sourceCapture factory and installed authenticated HTTP/PostgreSQL collection;
genuine previous-main artifacts separately establish migration compatibility.
The native corpus records Claude Code 2.1.263 source facts with controlled mock
responses, not real provider billing or a promise for every Claude version.
Package publication, Server deployment and production database migration are
separate actions.
