# ATape Codex Adapter


The 0.5.11 `legacy-bridge` release retains the published 0.5.10 capture
Implementation while the CLI gains target-owned automatic updates.
The Codex Adapter keeps Canonical v3 and projection/cursor v5. Ordinary native-tool identity and file-activity capture are
planned for the subsequent `target-owned` release. See
[ADR-0126](../../docs/architecture/adr/0126-target-owned-managed-updates.md).

```sh
atape
atape
```

In **Tools and updates**, add Codex to the existing global selection and review
the affected Projects. Installing the package alone does not authorize capture.

The Adapter reads from `ATAPE_CODEX_HOME`, then `CODEX_HOME`, and otherwise `~/.codex`. It only reports sessions whose recorded working directory or Git repository matches the configured Project. Provider files remain untouched when ATape captures or removes local Project configuration.

This Adapter requires an updated ATape CLI and a Server supporting explicit unknown source clocks. Missing or invalid conversation timestamps remain unknown. Filesystem modification times drive collection progress and provide a stable legacy Raw capture basis for retries; they do not become conversation timestamps. Upgrading replays retained Canonical source history once while keeping acknowledged Raw byte offsets.

Installation does not run npm lifecycle scripts. The release tarball therefore contains a ready-to-run `dist/index.js` bundle and requires Node.js 24 or newer.

This package is available under the MIT License.

Choose Codex in Tools and updates → Choose tools to sync to install and enable it.
