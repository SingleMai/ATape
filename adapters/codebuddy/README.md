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
`projects/*/*.jsonl`; it does not traverse symlinks. A root opens only child files proven by its
completed native Agent receipts.

The first implementation targets controlled CodeBuddy Code CLI 2.124.0 samples
from macOS arm64. It supports linear primary CLI Sessions, native `--fork-session` (including nested forks), ordinary resume,
text/thoughts, tool calls/results, manual `/compact`, engineering pre-message
automatic compaction, completed foreground Agent families (resume and nesting),
root-level background Agents through native automatic teams (serial SendMessage
continuation and ordinary foreground resume),
completed emergency compaction in roots and foreground children, and normalized
per-Thread response usage.
Rewind, `/branch`, pre-message LLM summaries, named teams/generic inbox turns,
overlapping or batched background messages, broadcasts, nested background launches, fork subagents,
manual/pre-message child compaction, emergency compaction in background children
or forks, forks with children, unknown sidecar fields and external
blob/spill collection have no support promise. Unsupported shapes retain the
previous published view and produce diagnostics. Unknown content stays Raw-only
when enabled and marks capture partial.

Fork identity and Project attribution come from its first fork-owned user record,
with native sidecar proof. Copied usage describes captured history and is not
new-spend evidence. The original parent file is not required.

Compaction retains the original transcript. Manual commands and summaries remain
visible; engine-generated context is Raw-only. Completed emergency summary/continue
pairs preserve the original transcript and stay within the same delegated turn.
Incomplete manual or emergency compaction keeps
the previous publication. Exact flags and remaining limits are in the guide.

Parent Agent calls link to child Threads; the parent’s original Project owns all
members even when child CWD differs. Missing or incomplete members retain the
whole prior publication. Background assignment/follow-up wrappers stay in Raw;
the reader shows the delegated prompt. Proven SendMessage and Agent resume calls
link to the same child. Known reactivation/completion notifications are Raw-only;
other inbox shapes are unsupported. Team mailboxes are not read. See the guide for exact membership evidence.

Each complete family snapshot (including metadata) is limited to 16 MiB; projection snapshots to
64 MiB; discovery to 10,000 entries. Host row/page/event/deadline limits also
apply. Incomplete final lines wait for a complete subsequent snapshot. Source
removal preserves already captured history. All delivery and Raw recovery use
the existing Host journal and receipts.

See the [CodeBuddy guide](../../docs/adapters/codebuddy.md) for mapping, evidence,
limitations, recovery and remaining work.
