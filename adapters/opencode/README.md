# ATape OpenCode Adapter candidate

This private `0.0.0` package reads local OpenCode SQLite history through the
Host-owned bounded source-capture Interface. It is self-contained ESM for Node.js
24 or later. It is not published to npm or registered in ATape's default tool list.

The supported evidence is the v1 SQLite schema and controlled native records from
OpenCode 1.18.30. Other versions, nonempty v2 storage and old JSON-only history are
not claimed as supported. Missing or unsupported sources fail explicitly; this
Adapter does not migrate history, run OpenCode or invoke an export fallback.

The default source is `$XDG_DATA_HOME/opencode/opencode.db`, or
`~/.local/share/opencode/opencode.db` when `XDG_DATA_HOME` is unset. `OPENCODE_DB`
selects an absolute file or a filename relative to that native data directory.
Source access is read-only. Project attribution uses original creation evidence.

The package declares shared Git attribution. The Host resolves the original
creation directory through its Git repository evidence and current Server
authorization, including worktrees and other checkouts of the same repository.
Later OpenCode directory changes do not move the captured Session. A source in a
different repository is excluded; a missing origin without established evidence
remains unknown. This reuses the existing Host attribution Module.

The Host requires explicit source-collection admission, and the Server requires
publication admission. Raw capture obeys the current Host policy; this package
does not upload content or store credentials itself. Installing the candidate
does not enable it or select production capacity defaults.

From a checkout with the pinned workspace installed:

```sh
pnpm --filter @atape/adapter-opencode verify:package
```

This builds and packs the private candidate, installs it offline in a temporary
directory, and verifies the installed entry against controlled native data in a
fresh Node process. Full Collector/HTTP/PostgreSQL acceptance also installs this
tarball. No personal history or publication is needed for those checks.

See [implementation status](https://github.com/SingleMai/ATape/blob/main/docs/adapters/opencode.md)
for delivered behavior, evidence and remaining release gates.
