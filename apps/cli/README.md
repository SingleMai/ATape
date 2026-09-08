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
atape
```

The Ink setup defaults to the current directory and guides you through sign-in,
Team selection, Project matching and conversation sources. Review the destination
and selected sources once; setup then installs integrations as needed, imports
existing history and starts continuing background sync. No Team yet? Open Web
onboarding and choose Refresh when you return. `atape setup /path/to/project`
opens the same guide for another directory.

Running `atape` again opens your Project console. It shows waiting, syncing,
queued history, up-to-date, partial and failed outcomes, and lets you manage
sources, open Web Projects and remove local capture. Exiting leaves background
sync running. After reboot, run `atape start`; automatic boot persistence is not
included. Stop from the console explicitly affects every Project.

Git Projects cover the repository across worktrees and independent clones.
Repeating setup from another checkout updates its locator while preserving
sources and collection progress. `--type directory` applies only outside Git.
Codex and Claude require shared Git attribution support on both CLI and Adapter.

The default Instance is `https://atape.net`; pass `--instance https://atape.example`
for a self-hosted Instance. Local configuration, credentials and progress remain
under `~/.atape`. History is uploaded only after your explicit source review.

Scripts and unsupported terminals retain explicit commands without entering Ink:

```sh
atape login --no-browser
atape adapters install @atape/adapter-codex
atape setup /path/to/project --team <team-slug> --create --adapter codex --json
atape start --json
atape status --json
```

`--help` lists the complete automation Interface. Pipes, CI and `TERM=dumb` never
wait for input. Use `atape migrate-local-v0.1` to review existing v0.1 XDG data;
apply migration explicitly before setup.

## Build and verify from the repository

```sh
pnpm --filter @atape/cli build
pnpm test:cli-package
pnpm test:release
pnpm pack:release
```

The CLI package verification requires Python 3 for its macOS/Linux PTY checks. It installs its generated tarball into an isolated npm prefix, installs a temporary Adapter, starts the bundled background Collector, observes a successful cycle, and stops it without using the source tree at runtime. It also checks installed Ink controls, terminal restoration, guided login/Web Refresh, confirmed setup and source management. Release verification additionally exercises the independently bundled Codex and Claude Adapters and package replacement recovery. `release/SHA256SUMS` covers all three artifacts.
