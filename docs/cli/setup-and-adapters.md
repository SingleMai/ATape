# Local setup and Adapter management

The [CLI experience initiative](experience-improvement.md) tracks the Ink setup
and Project console. This guide also documents the explicit command Interface.

The ATape CLI keeps capture authorization explicit and local. `setup` records which Git repositories or ordinary directories may be observed, Adapter commands manage independently installed Harness integrations, and `collect` runs the bounded upload workflow.

## Install the CLI

ATape's CLI is a public npm package containing one bundled `atape` executable with no workspace runtime dependencies. It requires Node.js 24 or newer.

```sh
npm install --global @atape/cli
atape --version
```

The checksummed GitHub Release tarball remains an equivalent offline installation source. Repository maintainers create the complete CLI + Codex/Claude Adapter release set with `pnpm pack:release`, verify the clean installation boundary with `pnpm test:release`, and follow [`docs/releasing.md`](../releasing.md) for publication.

## Guided setup and Project console

Run `atape` in a macOS or Linux terminal. On first use it opens
setup; after tools have been configured it opens your Project list, even when empty. `atape setup [directory]` opens the
same guide to add another Project. Explicit command flags such as `--team`,
`--create` and `--json` retain the command workflow below.

First use configures tools globally, then offers directory browsing, browser
sign-in and Team selection when needed. Detection checks known local tool data
directories; it does not scan the disk or guarantee this Project has history.
Saving tools installs their integrations but does not connect any Project.
Review the Instance, account, Team, Project, global tools and historical import
before confirming capture and starting sync. Subsequent Projects reuse the global
tools. No Teams means Web onboarding, then Refresh; the directory remains selected.

The initial wait is bounded to 15 seconds. Waiting for a first conversation,
syncing, queued history, up to date, partial coverage and failure are distinct
outcomes. Use `r` or leave the console open for updates. Project details provide
sync details, relevant recovery and disconnection. Tools and accounts are global
flows. Tool changes preview their impact on every Project before saving and affect
subsequent cycles; an in-flight upload may finish. Stop in Settings requires a
review because it affects all local Projects. Esc returns without a duplicate
Back menu row. The cassette remains in the shared responsive header.

Use arrows and Enter to navigate, Space to select sources, Escape to go back or
cancel, and Ctrl+C to exit. Path input supports paste, Unicode, Home/End and
Ctrl+A/E/U/K. PgUp/PgDn pages long details on narrow screens. Exiting restores the
terminal and leaves the independently managed Collector running. After reboot,
`atape start` resumes collection manually.

Pipes, CI, Windows and `TERM=dumb` get plain guidance; use explicit commands and
JSON for automation. Configuration completed before cancellation is retained.
An interrupted source installation can be retried, and confirmed directory-Project
creation retains a request key under `config/setup-requests/` to reuse the server's
idempotency contract. Existing local directory registrations are reused. These
files contain request keys, not conversation data.

## Sign in

The CLI uses the Instance's browser login. It opens a short-lived approval page and also prints a six-character code so a headless terminal can finish the same flow:

```sh
pnpm atape login
pnpm atape login --instance https://atape.example
pnpm atape login --no-browser
```

Instance selection is `--instance`, then `ATAPE_INSTANCE_URL`, then the last successfully selected Instance, then `https://atape.net`. Production credentials are sent only to a freshly rediscovered, exactly pinned HTTPS API origin; redirects and discovery drift fail closed. Plain HTTP requires `ATAPE_DEVELOPMENT_ALLOW_HTTP=true` and an all-loopback topology.

Credentials are isolated by Instance. `pnpm atape logout [--instance ...]` removes the selected local credential even when remote revocation cannot be confirmed. Re-login durably stores the replacement before revoking the old credential.

## Configure a Project

Run setup from a Project directory:

```sh
pnpm atape setup --team acme-engineering --create
```

Configure global tools, then provide a directory and Instance explicitly:

```sh
pnpm atape tools configure --adapter codex
pnpm atape tools configure --adapter codex --apply
pnpm atape setup ../payments-api \
  --instance https://atape.example \
  --team acme-engineering \
  --create
```

The User, Team, and Project authority always comes from the authenticated server; the CLI has no flags that let callers assert those identities. The default `--type auto` behavior promotes a path inside a Git worktree to the repository root, reads its `origin`, and searches every visible Team for an exact repository match. One exact match is attached automatically. No match requires an explicit Team and `--create`; ambiguous matches require an explicit selection. Git repositories always use repository identity, including worktrees and independent clones. `--type directory` is accepted only outside Git. `--type git` rejects paths outside a Git worktree or without an origin remote; fix the remote before continuing.

Each local Project stores its verified Instance, User, Team, server Project, type, and resolved path; Git setup also stores the server repository identity. The path never crosses the HTTP boundary as identity. Repeating an identical setup is idempotent. Repeating Git setup from another checkout of the same Project updates the local path and verified display metadata while preserving enabled sources and collection progress. Tools are derived from the global selection; Project setup has no tool override. To change Project identity, remove the local Project and set it up again:

```sh
pnpm atape projects list
pnpm atape projects remove payments-api
```

Removal only changes this machine's configuration. It never deletes conversation history already captured by the ATape server.

## Git conversation attribution

Codex and Claude use the same Host attribution contract. Codex supplies the
original rollout CWD and recorded Git remote when available; Claude supplies the
original root record's CWD. The Host resolves the nearest repository when needed
and asks the configured Instance to match its remote in the selected Team. The
server owns remote equivalence and repository aliases. A nested unrelated
repository is excluded even when its path is under the configured checkout.

Confirmed source evidence stays in local metadata so an established conversation
can continue after `/cd`, a changed origin or deletion of its original directory.
New conversations must establish their own attribution. Unknown historical
identity is skipped and reported as `attribution` in partial collection diagnostics;
paths alone never guess it. A known different repository is simply excluded.
Network or authentication failures fail the job without acknowledging its page.

Git collection requires a Host and Adapter declaring
`atape.git-attribution.v1`; upgrade the CLI and enabled Git Adapters together.
Incompatible packages are
rejected for Git capture before import, with upgrade guidance. Directory capture
keeps its existing contract, but a previously configured directory that is now
inside Git must be reconnected as a Git Project.

## Tools and Adapter packages

The Tools screen manages one selection for all connected Projects on this
machine. The equivalent commands preview changes unless `--apply` is explicit:

```sh
pnpm atape tools list --json
pnpm atape tools configure --adapter codex --adapter claude --json
pnpm atape tools configure --adapter codex --adapter claude --apply --json
pnpm atape tools configure --none --apply
```

Added tools import attributable history and continue syncing for connected
Projects. Disabled tools retain server history and checkpoints. A plan becomes
invalid if Projects or global selection change before it is saved. Failed or
cancelled installation never partially enables tools; inert installed packages
may be reused on retry. Project setup cannot install or update tools.

ATape is still in development. One current schema stores global tool selection
and Project registrations separately. There is no configuration migration or
compatibility path for earlier development versions. Commands and the Collector
derive effective Project tools from the same global selection.

An Adapter may come from the npm registry, a local package directory, an npm `.tgz` archive, or an HTTPS archive URL such as a GitHub Release asset:

```sh
pnpm atape adapters install @atape/adapter-codex
pnpm atape adapters install ../atape-adapter-custom
pnpm atape adapters install ./release/atape-adapter-codex-0.1.0.tgz
pnpm atape adapters install https://github.com/OWNER/ATape/releases/download/v0.1.0/atape-adapter-codex-0.1.0.tgz
```

While developing this repository, install its first-party Codex Adapter directly:

```sh
pnpm atape adapters install ./adapters/codex
```

Local and remote archives are read with explicit compressed, expanded, and manifest size limits. ATape streams their TAR structure and validates `package/package.json` before asking npm to install them; it never extracts the archive itself. Every installation disables npm lifecycle scripts and validates the installed entry without importing it. A package must therefore contain ready-to-run output. Installing an Adapter does not start a process, though enabling it means its code will execute later inside the Collector Host.

The Collector Host loads globally enabled Adapters for each connected Project.
There is no persistent sidecar per installed Adapter.

Upgrade one Adapter or all installed Adapters:

```sh
pnpm atape adapters upgrade codex
pnpm atape adapters upgrade --all
```

Bulk upgrades run sequentially because the packages share one isolated npm installation tree. Registry packages resolve `latest`; local directories and archives keep their canonical local source path; HTTPS installations fetch the same URL again. Release URLs should therefore either be stable update endpoints or be replaced by explicitly installing a newer asset.

## Run collection

Start one managed background Collector after setup:

```sh
pnpm atape start
pnpm atape status
pnpm atape stop
```

On macOS and Linux, the process runs every 30 seconds by default and stays alive after the starting terminal closes. `status` reports whether the process is running plus each configured Project/Adapter's last success time, current failure reason, and latest bounded counters. It does not expose conversation bodies. The managed process does not promise restart after logout or reboot; an external supervisor may still invoke `collect --once` when boot persistence is required. Windows retains foreground `collect` until ATape can verify managed process ownership without relying on a reusable PID alone.

Run one bounded cycle for diagnosis or an external scheduler:

```sh
pnpm atape collect --once
pnpm atape collect --once --project payments-api --json
```

Run continuously in the foreground for debugging, or configure the same interval and concurrency on the managed process:

```sh
pnpm atape collect
pnpm atape start --interval 10 --concurrency 4
```

The Collector runs at most four Project/Adapter jobs concurrently by default and caps the value at eight. Within each job it pulls bounded pages sequentially. `Ctrl+C` and `SIGTERM` interrupt Adapter work and release loaded runtimes.

Each page follows this commit order:

1. Validate the Adapter output and apply client-side secret redaction.
2. Commit each Canonical Session observation and receive its stable server Session ID.
3. Redact each complete Adapter Raw segment, divide it into bounded 3 MiB transport chunks, and append them through the separate Raw endpoint.
4. Persist the source/server offset after every complete Adapter segment while leaving the Adapter cursor unchanged.
5. Atomically advance the opaque Adapter cursor only after the complete page succeeds.

If Raw fails after Canonical succeeds, the cursor remains unchanged. The next cycle replays the Canonical batch, skips Raw source bytes already recorded in the local progress checkpoint, and resumes at the first unacknowledged segment. If the server accepted a segment immediately before the client lost power, its deterministic identity makes that final replay safe. Source deletion never sends a delete to ATape.

## Local state

All default client data lives below `ATAPE_HOME`, which defaults to `~/.atape`:

- Credentials: `~/.atape/credentials/`
- Configuration: `~/.atape/config/client.json`
- Collector checkpoints, process metadata, and status: `~/.atape/state/`
- Git attribution evidence: beside the Collector state file, in `<state-file>.git-attribution/`
- Background logs: `~/.atape/logs/collector.log`
- Adapter packages: `~/.atape/adapters/`

`ATAPE_HOME` relocates the whole layout. Individual `ATAPE_CONFIG_FILE`, `ATAPE_COLLECTOR_STATE_FILE`, `ATAPE_COLLECTOR_PROCESS_FILE`, `ATAPE_COLLECTOR_STATUS_FILE`, `ATAPE_COLLECTOR_LOG_FILE`, and `ATAPE_ADAPTER_DIRECTORY` overrides remain available for development. Credentials use opaque per-Instance filenames, owner-only directories/files, no-follow reads, compare-and-swap updates, and fsynced atomic replacement. Local filesystem paths remain client state and are not part of server Project, Canonical, Raw, or Search payloads.

The checkpoint file stores only an installation ID, opaque cursors, and per-Raw-object offsets; it never queues conversation bodies. Raw content is re-read from the Harness through an unadvanced cursor after a failed upload, while acknowledged source ranges are skipped.

Git attribution evidence contains source identifiers, original CWD and remote,
never conversation bodies or upload acknowledgements. Preserve it with Collector
state; losing it can make history unattributable when its original checkout is
gone and the provider did not record a remote. Saved remotes are matched against
the server again during collection.

The redactor covers common credentials and environment values whose names end in `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `CREDENTIAL`, `DATABASE_URL`, or `DSN`. Add exact values with a JSON array in `ATAPE_REDACT_VALUES`. Identity fields are stable and are not rewritten, so Adapter authors must never place secrets in IDs.

Every listing command supports `--json` for scripts.

The executable package contract is documented in [Adapter package and runtime contract](../adapters/package-manifest.md). Provider-specific behavior is documented in the [Codex Adapter guide](../adapters/codex.md).
