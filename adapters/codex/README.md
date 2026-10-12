# ATape Codex Adapter

The 0.5.12 `target-owned` Adapter restores native tool identity and recorded
file activity through Canonical v5 and projection/cursor v7. The 0.5.11
`legacy-bridge` retains its genuine Canonical v3/projection v5 capture for older
clients. The verified target CLI owns preparation of this v5 Adapter; see
[ADR-0126](../../docs/architecture/adr/0126-target-owned-managed-updates.md).
See the [0.5.12 release notes](../../docs/releases/v0.5.12.md) for publication,
deployment and acceptance evidence.

This package lets the ATape Collector read Codex rollout archives that belong to a configured local Project. It is installed independently from the base CLI and loaded only while an enabled Project is collected.

```sh
atape
atape
```

In **Tools and updates**, add Codex to the existing global selection and review
the affected Projects. Installing the package alone does not authorize capture.

The Adapter reads from `ATAPE_CODEX_HOME`, then `CODEX_HOME`, and otherwise `~/.codex`. It only reports sessions whose recorded working directory or Git repository matches the configured Project. Provider files remain untouched when ATape captures or removes local Project configuration.

This Adapter requires an updated ATape CLI and a Server supporting Canonical v5 with explicit unknown source clocks and stable tool identities and typed file activity. Missing or invalid conversation timestamps remain unknown. Filesystem modification times drive collection progress and provide a stable legacy Raw capture basis for retries; they do not become conversation timestamps. Upgrading from projection 5 or 6 to 7 replays retained Canonical source history once while keeping acknowledged Raw byte offsets and assigned source ordering. New cursors require the matching newer Adapter; recover forward without deleting state.

Native command, file-change and image-view items have stable tool identities independent of their display titles. Function and custom calls use their explicit native name; MCP items preserve their explicit server/tool pair and original input fields for upload redaction. Missing or invalid names and unknown Extension items stay unidentified, and absent outcomes remain unknown. Function-call kind remains the existing display classification; it does not establish identity. Recorded path facts do not establish successful file changes.

Installation does not run npm lifecycle scripts. The release tarball therefore contains a ready-to-run `dist/index.js` bundle and requires Node.js 24 or newer.

This package is available under the MIT License.

Choose Codex in Tools and updates → Choose tools to sync to install and enable it.

The file activity projection uses native
`CommandExecution.parsed_cmd` read/search paths, typed `FileChange.changes` keys
and move destinations, and `ImageView.path`. Search paths are scopes rather than
matching files. Shell commands, old patch envelopes and MCP inputs are not
classified. Missing, malformed, oversized or redacted paths remain unknown.
See the [Adapter guide](../../docs/adapters/codex.md#explicit-file-activity).
