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

The package contains one bundled executable. Internal workspace packages are not
installed globally. The Tools flow installs the selected tool integrations as
separate packages; manual Adapter installation remains available for custom or
offline packages.

Checksummed `.tgz` files attached to each GitHub Release provide the equivalent offline installation path.

## Upgrade

```sh
atape upgrade
```

The interactive console also offers available updates. The built-in upgrade
resumes previously running sync and preserves supported local state; Adapter
updates are separate. See the [upgrade procedure](../../docs/cli/setup-and-adapters.md#upgrade-the-cli-and-adapters)
for manual package replacement, pinned Adapter sources and failed-resume recovery.

## First Project

```sh
atape
```

First choose your tools once for this machine, then connect a Project directory.
The guide reuses sign-in and unambiguous destinations. Review the destination,
global tools and historical import before confirming the connection. No Team yet?
Open Web onboarding and choose Refresh when you return. `atape setup /path/to/project`
adds another Project using the same tools, without repeating tool selection.

Running `atape` again opens your Project console. It shows waiting, syncing,
queued history, up-to-date, partial and failed outcomes. Home offers Add project,
Tools and Settings; Project details show outcomes, recovery and disconnection.
Use `r` to refresh in place and Esc to return. The theme-color cassette remains
visible on every interactive page and adapts to terminal size. Exiting leaves background
sync running. After reboot, run `atape start`; automatic boot persistence is not
included. Stop in Settings explicitly affects every Project.

Git Projects cover the repository across worktrees and independent clones.
Repeating setup from another checkout updates its locator while preserving
sources and collection progress. `--type directory` applies only outside Git.
Codex, Claude and OpenCode require shared Git attribution support on both CLI and Adapter.

The default Instance is `https://atape.net`; pass `--instance https://atape.example`
for a self-hosted Instance. Local configuration, credentials and progress remain
under `~/.atape`. History is uploaded only for confirmed Projects and tools.

Tools apply to all connected Projects. A change previews per-Project additions
and removals before saving. Added tools include existing history; disabling tools
retains captured history and checkpoints. Tool selection is global; Project
registrations have no overrides. ATape is still in development and does not
provide compatibility or migration for older local configurations.

Scripts and unsupported terminals retain explicit commands without entering Ink:

```sh
atape login --no-browser
atape tools configure --adapter codex --json
atape tools configure --adapter codex --apply --json
atape setup /path/to/project --team "<team-slug>" --create --json
atape start --json
atape status --json
```

Replace `/path/to/project` and `<team-slug>` with your directory and Team. Use
`atape projects list --json` to obtain Project IDs for later remove/filter commands.
Follow [first-sync verification](../../docs/cli/setup-and-adapters.md#confirm-the-first-sync)
and [troubleshooting](../../docs/cli/setup-and-adapters.md#troubleshooting) if capture
is waiting, partial or failed.

`--help` lists the complete automation Interface. Pipes, CI and `TERM=dumb` never
wait for input.

## Build and verify from the repository

```sh
pnpm --filter @atape/cli build
pnpm test:cli-package
pnpm test:release
pnpm pack:release
```

The CLI package verification requires Python 3 for its macOS/Linux PTY checks. It installs its generated tarball into an isolated npm prefix, installs a temporary Adapter, starts the bundled background Collector, observes a successful cycle, and stops it without using the source tree at runtime. It also checks installed Ink controls, terminal restoration, guided login/Web Refresh, confirmed setup and global tool management. Release verification additionally exercises the independently bundled Codex, Claude and OpenCode Adapters and package replacement recovery. `release/SHA256SUMS` covers all four artifacts.

OpenCode reads local v1 SQLite history. Its accepted source/version/platform scope,
source discovery, bounded defaults and Server prerequisite are documented in the
[OpenCode guide](../../docs/adapters/opencode.md).
