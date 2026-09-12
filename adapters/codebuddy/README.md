# ATape CodeBuddy Code CLI Adapter

An independently installable `@atape/adapter-codebuddy` package for bounded local
CodeBuddy Code CLI JSONL history. Node.js 24 or newer is required. This source
uses `atape.source-capture.v1`; the receiving Server must advertise
`atape.publication.v1`.

## Build and enable

From the repository root:

```sh
pnpm --filter @atape/adapter-codebuddy build
pnpm pack:adapter-codebuddy
atape
```

Open **Tools and updates → Integration maintenance → Install from a package or path**
and install `./release/atape-adapter-codebuddy-0.5.1.tgz`. Then use **Choose tools to sync**
to add CodeBuddy Code CLI to the existing selection.
Review the affected connected Projects before applying. Installation alone does
not enable collection. Start sync from Home and inspect **Project → Sync details**.

Source resolution: `ATAPE_CODEBUDDY_HOME`, then `CODEBUDDY_CONFIG_DIR`, then
`~/.codebuddy`. Overrides must be absolute. Discovery reads
`projects/*/*.jsonl`; it does not traverse symlinks or nested subagent files.

The first implementation targets controlled CodeBuddy Code CLI 2.124.0 samples
from macOS arm64. It supports linear primary CLI Sessions, ordinary resume,
text/thoughts, tool calls/results and normalized per-response token usage.
Fork/rewind/compaction, child agents, sidecar-dependent histories and external
blob/spill collection have no support promise. Unsupported shapes retain the
previous published view and produce diagnostics. Unknown content stays Raw-only
when enabled and marks capture partial.

Each complete source snapshot is limited to 16 MiB; projection snapshots to
64 MiB; discovery to 10,000 entries. Host row/page/event/deadline limits also
apply. Incomplete final lines wait for a complete subsequent snapshot. Source
removal preserves already captured history. All delivery and Raw recovery use
the existing Host journal and receipts.

See the [CodeBuddy guide](../../docs/adapters/codebuddy.md) for mapping, evidence,
limitations, recovery and remaining work.
