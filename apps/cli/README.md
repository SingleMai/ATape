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
atape login
atape adapters install <adapter-package>
atape setup /path/to/project --team <team-slug> --create --adapter <adapter-id>
atape adapters enable <adapter-id> --project <project-id>
atape start
atape status
```

`login` opens the selected Instance in a browser and prints the same six-character, case-insensitive code for manual use. The default Instance is `https://atape.net`; self-hosted users pass `--instance https://atape.example`. Credentials, local paths, Adapter configuration, checkpoints, and Collector health remain under `~/.atape` on this machine. Canonical and Raw conversation data are uploaded only for explicitly configured Projects.

For a Git worktree, setup detects `origin` and attaches a unique exact Project match. Creating a new server Project always requires `--create`; local paths are never sent as Project identity. Run `atape migrate-local-v0.1` before using an existing v0.1 XDG layout, then add `--apply` only after reviewing the plan.

## Build and verify from the repository

```sh
pnpm --filter @atape/cli build
pnpm test:cli-package
pnpm test:release
pnpm pack:release
```

The CLI package verification installs its generated tarball into an isolated npm prefix, installs a temporary Adapter, starts the bundled background Collector, observes a successful cycle, and stops it without using the source tree at runtime. Release verification additionally installs the independently bundled Codex Adapter through that packaged CLI and executes a collection cycle. `release/SHA256SUMS` covers both artifacts.
