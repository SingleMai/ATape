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

Before opening the interactive console, ATape checks for a newer release using
a twelve-hour cache and a short network timeout. If one is available, choose
`Upgrade and continue` or `Skip`. Skip enters the original flow for this session;
upgrading reopens the newly installed CLI with the same arguments and ATAPE_HOME.
The choice appears again on later launches while an update remains available.
An offline or failed check proceeds normally. Upgrade failures offer Retry and
Skip; Escape exits instead of bypassing the choice.
If installation succeeds but background sync cannot resume, choose
`Resume sync and continue` to retry sync without reinstalling, or `Skip` to open
the new CLI with sync stopped.

```sh
atape upgrade
```

This checks npm for the latest stable CLI and updates the active npm global
installation. Already current versions need no action. After a successful
upgrade, previously running background sync resumes with the same settings;
stopped sync stays stopped. Use the same `ATAPE_HOME` as usual. Projects, login
and sync checkpoints are retained. Adapter packages have their own
`atape adapters upgrade --all` command.

For an installation owned by another package manager, use that manager's update
command. Repository development builds cannot upgrade themselves. Startup
update choices do not appear in scripts or JSON output; `atape upgrade --json` returns
the version and whether the CLI was updated and sync resumed.

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
Codex and Claude require shared Git attribution support on both CLI and Adapter.

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
atape setup /path/to/project --team <team-slug> --create --json
atape start --json
atape status --json
```

`--help` lists the complete automation Interface. Pipes, CI and `TERM=dumb` never
wait for input.

## Build and verify from the repository

```sh
pnpm --filter @atape/cli build
pnpm test:cli-package
pnpm test:release
pnpm pack:release
```

The CLI package verification requires Python 3 for its macOS/Linux PTY checks. It installs its generated tarball into an isolated npm prefix, installs a temporary Adapter, starts the bundled background Collector, observes a successful cycle, and stops it without using the source tree at runtime. It also checks installed Ink controls, terminal restoration, guided login/Web Refresh, confirmed setup and global tool management. Release verification additionally exercises the independently bundled Codex and Claude Adapters and package replacement recovery. `release/SHA256SUMS` covers all three artifacts.
