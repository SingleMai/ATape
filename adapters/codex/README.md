# ATape Codex Adapter

This package lets the ATape Collector read Codex rollout archives that belong to a configured local Project. It is installed independently from the base CLI and loaded only while an enabled Project is collected.

```sh
atape adapters install @atape/adapter-codex
atape
```

In **Tools and updates**, add Codex to the existing global selection and review
the affected Projects. Installing the package alone does not authorize capture.

The Adapter reads from `ATAPE_CODEX_HOME`, then `CODEX_HOME`, and otherwise `~/.codex`. It only reports sessions whose recorded working directory or Git repository matches the configured Project. Provider files remain untouched when ATape captures or removes local Project configuration.

Installation does not run npm lifecycle scripts. The release tarball therefore contains a ready-to-run `dist/index.js` bundle and requires Node.js 24 or newer.

This package is available under the MIT License.
