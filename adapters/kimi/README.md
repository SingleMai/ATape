# @atape/adapter-kimi

Kimi Code CLI Adapter for ATape. Reads local Kimi Code 0.42.0 main-agent Wire
1.5 Sessions through the source-capture runtime. Node.js 24 or newer is required.

Build and pack from the repository root:

```sh
pnpm --filter @atape/adapter-kimi build
pnpm pack:adapter-kimi
```

In the `atape` console, open **Tools and updates**, install the local tarball
under **Integration maintenance**, then include **Kimi Code CLI** in the selected
Tools for connected Projects. When published, the official package is
`@atape/adapter-kimi`; this checkout does not establish registry availability.
See [CLI setup](../../docs/cli/setup-and-adapters.md).

`ATAPE_KIMI_HOME` overrides `KIMI_CODE_HOME`, otherwise `~/.kimi-code` is used.
Overrides must be absolute. The Adapter reads `sessions/*/*/state.json` and the
matching `agents/main/wire.jsonl`; it does not need Kimi installed or credentials.
The Server must advertise `atape.publication.v1`.

Supports completed main-agent turns and resume, user/assistant text, thoughts,
tool outcomes, manual/automatic compaction, `/undo`, `/clear` as a new Session,
and response usage. Undo removes visible turns while retaining expenditure;
compaction preserves reading history and keeps internal summaries in Raw.
Forks, subagents, steering, interrupted/retried turns and tree storage remain
unsupported. Legacy Python kimi-cli is intentionally excluded. Unsupported
sources retain previously captured history and produce diagnostics. Images/blobs
are Raw-only; referenced files are not opened.

The [Kimi guide](../../docs/adapters/kimi.md) owns detailed support, identity,
Raw policy, bounds, recovery and verification evidence.
