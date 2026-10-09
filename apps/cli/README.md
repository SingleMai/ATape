# ATape CLI

The ATape CLI registers local Projects, manages independently installed Harness Adapters, and runs the background Collector that uploads shared conversation history to an ATape server.

## Requirements

- Node.js 24 or newer
- An interactive macOS or Linux terminal

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

Automatic updates are on by default for supported macOS/Linux npm-global
installations. Settings offers Turn off automatic updates or Turn on automatic
updates. A running Collector or opening the CLI can trigger an approximately
daily background check. The independent updater prepares the CLI and installed
official registry Adapters at one completed release version, then switches their
version directories through a bounded Collector stop/restart. Custom, local,
archive and URL installations keep their chosen source.

Open `atape` → Tools and updates and select the available update.

With automatic updates on, startup enters the console without an upgrade prompt.
When off, startup retains Upgrade and continue or Skip. The explicit CLI upgrade
resumes previously running sync and preserves supported local state; Adapter
maintenance remains separate. This manual operation uses the original in-place
npm path; automatic updates use isolated version directories. See the [upgrade procedure](../../docs/cli/setup-and-adapters.md#upgrade-the-cli-and-adapters)
for manual package replacement, pinned Adapter sources and failed-resume recovery.
Automatic updates preserve user-stopped sync and recover only within compatible
local-state contracts. They do not add reboot supervision or upload local logs.

## First Project

```sh
atape
```

First choose your tools once for this machine, then connect a Project directory.
The guide reuses sign-in and unambiguous destinations. Review the destination,
global tools and historical import before confirming the connection. No Team yet?
Open Web onboarding and choose Refresh when you return. Add project (`n`)
connects another directory using the same global tools.

Running `atape` again opens your Project console. It shows waiting, syncing,
queued history, up-to-date, partial and failed outcomes. Home offers Add project,
Tools and Settings; Project details show outcomes, recovery and disconnection.
Use `r` to refresh in place and Esc to return. The theme-color cassette remains
visible on every interactive page and adapts to terminal size. Exiting leaves background
sync running. After reboot, open ATape and select Start sync; automatic boot persistence is not
included. Stop in Settings explicitly affects every Project.

Git Projects cover the repository across worktrees and independent clones.
Repeating setup from another checkout updates its locator while preserving
sources and collection progress. Ordinary folder Projects apply only outside Git.
Codex, Claude, OpenCode and CodeBuddy require shared Git attribution support on both CLI and Adapter.

The default Instance is `https://atape.net`; use Settings → Change server
for a self-hosted Instance (or set `ATAPE_INSTANCE_URL`). Local configuration, credentials and progress remain
under `~/.atape`. History is uploaded only for confirmed Projects and tools.

Tools apply to all connected Projects. A change previews per-Project additions
and removals before saving. Added tools include existing history; disabling tools
retains captured history and checkpoints. Tool selection is global; Project
registrations have no overrides. ATape is still in development and does not
provide compatibility or migration for older local configurations.

`atape` is the only operational entry. Use Projects for connection and diagnostics,
Tools and updates for tool selection and versions, and Settings for accounts,
server, language and global sync. Integration maintenance under Tools supports
trusted package/path installation, original-source refresh and confirmed cleanup.

`--help` and `--version` work without a terminal. `--lang` changes the session
language; `--no-browser` displays sign-in links without opening a browser.
Business subcommands, JSON output and foreground collection are removed. CI,
pipes, Windows and `TERM=dumb` fail with plain guidance and exit status 2.
Follow [first-sync verification](../../docs/cli/setup-and-adapters.md#confirm-the-first-sync)
and [troubleshooting](../../docs/cli/setup-and-adapters.md#troubleshooting) for recovery.

## Build and verify from the repository

```sh
pnpm --filter @atape/cli build
pnpm test:cli-package
pnpm test:release
pnpm pack:release
```

The CLI package verification requires Python 3 for its macOS/Linux PTY checks. It installs its generated tarball into an isolated npm prefix, installs a temporary Adapter, starts the bundled background Collector, observes a successful cycle, and stops it through the installed executable. Source fixtures prepare inert test integrations and dispatch a real packaged independent updater against controlled GitHub/npm Adapters. The update check verifies one CLI/Adapter generation, unchanged raw configuration/bootstrap files, worker exit and bootstrap delegation without updating the user's installation. It also checks installed Ink controls, terminal restoration, guided login/Web Refresh, confirmed setup and global tool management. Release verification exercises the independently bundled Codex, Claude, OpenCode, CodeBuddy, Kimi and Grok Adapters through the source Node Host and package replacement recovery. `release/SHA256SUMS` covers all seven artifacts.

OpenCode reads local v1 SQLite history. Its accepted source/version/platform scope,
source discovery, bounded defaults and Server prerequisite are documented in the
[OpenCode guide](../../docs/adapters/opencode.md).
