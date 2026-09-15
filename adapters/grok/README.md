# @atape/adapter-grok

ATape Adapter for Grok Build 1.0.3 and 1.0.30 local completed root conversations on macOS
arm64: text, successful/failed file reads, foreground terminal commands, grep search, search_replace edits, ordinary
resume, headless forks/nested forks and their continuation, and per-turn/model usage.
The 1.0.30 profile also captures retained-history manual `/compact` commands
and continuation; failed commands mark capture partial, and compression counters
are not model usage.
Forks retain copied history under independent identities; copied usage describes
that history, not additional model spend. Other tools, child Sessions, rewind,
automatic compaction, compacted forks, interrupted turns and non-text messages remain unsupported in this
bounded profile. See the [Grok guide](../../docs/adapters/grok.md) for evidence and
limits.

Build with `pnpm --filter @atape/adapter-grok build`, then install the prepared
package through **Tools and updates → Integration maintenance → Install from a package or path** using the
absolute package directory or tarball. Select **Grok Build** while preserving
other enabled tools. Installation alone does not enable collection. A Server
advertising `atape.publication.v1` is required.

Sources default to `~/.grok`; `ATAPE_GROK_HOME` overrides `GROK_HOME`. Overrides
must be absolute. The Adapter only reads bounded snapshots of `summary.json`,
`updates.jsonl` and `signals.json` under `sessions/*/*/`. It does not execute Grok,
read authentication files or upload directly. Existing captured history survives
source deletion or an unsupported new target.

The package contains a self-contained bundle and installs with lifecycle scripts
disabled. `pnpm --filter @atape/adapter-grok verify:package` tests the actual tarball
outside the checkout. Packaging is not publication or deployment.
