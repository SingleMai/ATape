# ATape CLI

The ATape CLI registers local Projects, manages independently installed Harness Adapters, and runs the background Collector that uploads shared conversation history to an ATape server.

## Requirements

- Node.js 24 or newer
- macOS or Linux for `atape start`, `stop`, and `status`; Windows can run `atape collect`

## Install

```sh
npm install --global @atape/cli
atape --version
```

The package contains one bundled executable. Internal ATape workspace packages are not installed globally, and Harness Adapters remain separate packages. Install the first-party Adapter independently:

```sh
atape adapters install @atape/adapter-codex
```

Checksummed `.tgz` files attached to each GitHub Release provide the equivalent offline installation path.

## First Project

```sh
atape setup /path/to/project --user-id <your-name> --team-id <team-id>
atape adapters install <adapter-package>
atape adapters enable <adapter-id> --project <project-id>
atape start
atape status
```

Local paths, Adapter configuration, checkpoints, and Collector health remain on this machine. Canonical and Raw conversation data are uploaded only for explicitly configured Projects.

## Build and verify from the repository

```sh
pnpm --filter @atape/cli build
pnpm test:cli-package
pnpm test:release
pnpm pack:release
```

The CLI package verification installs its generated tarball into an isolated npm prefix, installs a temporary Adapter, starts the bundled background Collector, observes a successful cycle, and stops it without using the source tree at runtime. Release verification additionally installs the independently bundled Codex Adapter through that packaged CLI and executes a collection cycle. `release/SHA256SUMS` covers both artifacts.
