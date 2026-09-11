# ATape OpenCode Adapter

`@atape/adapter-opencode` reads local OpenCode SQLite history through the
Host-owned bounded source-capture Interface. It is self-contained ESM for Node.js
24 or later and participates in ATape's coordinated release package set.

The first supported source is **OpenCode 1.18.30 local v1 SQLite**, verified on
**macOS arm64 and Linux arm64 with glibc**. Other versions, architectures,
nonempty v2 storage, mixed history and old JSON-only history have no support
claim. Missing or unsupported sources fail explicitly. The Adapter does not
migrate history, run OpenCode or invoke an export fallback.

## Enable collection

In ATape's **Tools and updates** screen, add OpenCode to your existing selection
and review the affected Projects. The same selection applies to all connected
Projects. Installing a package alone does not enable collection or start sync.
The Server must expose `atape.publication.v1` with configured publication admission.

For a locally built release candidate, install its package before selecting it:

```sh
atape adapters install ./release/atape-adapter-opencode-<version>.tgz
atape
```

Repository integration does not publish this package to npm or deploy the Server.
Once published, normal tool setup can install the registry package. The CLI and
Adapter should use the same coordinated release version.

## Source and attribution

The default source is `$XDG_DATA_HOME/opencode/opencode.db`, or
`~/.local/share/opencode/opencode.db` when `XDG_DATA_HOME` is unset. `OPENCODE_DB`
selects an absolute file or a filename relative to that native data directory.
`:memory:` is not a durable local source. Setup detects regular files using
metadata only; it does not open history or promise schema compatibility.

Source access is read-only. Native platform checks preserve database and WAL
content; SQLite may update SHM lock metadata during reads. Project attribution
uses original creation evidence. The Host resolves that original directory through
shared Git attribution and current Server authorization, including worktrees and
other checkouts of the same repository. Later directory changes do not move the
Captured Session. Foreign repositories are excluded; missing origins without
established evidence remain unknown.

## Delivery and limits

The Collector supplies bounded defaults without an environment override. It
freezes validated, redacted delivery bytes before content upload and atomically
selects the complete Canonical revision. Raw delivery is independent and follows
the current Host policy; unresolved frozen bytes recover without rereading the
source. Raw-off does not retain full source JSON for later archival, and re-enable
does not change existing Event provenance merely to add Raw.

Limits are independent admission ceilings, not guarantees about history size,
resident memory or physical SQLite file size. Oversized or unsupported sources
report a failure while retaining published history. This package uploads no
content and stores no credentials itself.

## Verification

```sh
pnpm --filter @atape/adapter-opencode verify:package
```

This packs and installs the artifact offline outside the checkout, then verifies
bounded native discovery/projection, Raw policy, lifetime cancellation and
read-only source access in a fresh Node process. Release verification repeats
those checks against the exact checksummed tarball. Actual CLI/HTTP/PostgreSQL
acceptance covers background capture and package replacement preserving history.
Tests use controlled data, never personal history.

See the [feature guide](https://github.com/SingleMai/ATape/blob/main/docs/adapters/opencode.md)
for limits, native evidence, failure recovery and remaining scope.
