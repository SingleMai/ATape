# Local setup and Adapter management

The ATape CLI keeps capture authorization explicit and local. `setup` records which directories may be observed, Adapter commands manage independently installed Harness integrations, and `collect` runs the bounded upload workflow.

## Install the CLI

ATape's CLI is a public npm package containing one bundled `atape` executable with no workspace runtime dependencies. It requires Node.js 24 or newer.

```sh
npm install --global @atape/cli
atape --version
```

The checksummed GitHub Release tarball remains an equivalent offline installation source. Repository maintainers create the complete CLI + Codex Adapter release set with `pnpm pack:release`, verify the clean installation boundary with `pnpm test:release`, and follow [`docs/releasing.md`](../releasing.md) for publication.

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

Or provide a directory, Instance, and installed Adapter explicitly:

```sh
pnpm atape setup ../payments-api \
  --instance https://atape.example \
  --team acme-engineering \
  --create \
  --adapter codex
```

The User, Team, and Project authority always comes from the authenticated server; the CLI has no flags that let callers assert those identities. The default `--type auto` behavior promotes a path inside a Git worktree to the repository root, reads its `origin`, and searches every visible Team for an exact repository match. One exact match is attached automatically. No match requires an explicit Team and `--create`; ambiguous matches require an explicit selection. Use `--type directory` when the selected folder itself is the intended boundary, even when it sits inside a Git repository. `--type git` rejects paths outside a Git worktree or without an origin remote.

Each local Project stores its verified Instance, User, Team, server Project, type, and resolved path. The path never crosses the HTTP boundary as identity. Repeating an identical setup is idempotent. To change Project identity, remove the local Project and set it up again:

```sh
pnpm atape projects list
pnpm atape projects remove payments-api
```

Removal only changes this machine's configuration. It never deletes conversation history already captured by the ATape server.
If the same Project ID is registered again later, its new local creation timestamp starts a fresh Adapter cursor and Raw checkpoint. Existing server history is still retained and ingestion identities remain idempotent.

## Install and assign Adapters

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

Enable only the integrations needed by each Project:

```sh
pnpm atape adapters enable codex --project payments-api
pnpm atape adapters disable codex --project payments-api
pnpm atape adapters list
```

The Collector Host loads only the Adapters enabled for the Project being collected. There is no persistent sidecar per installed Adapter.

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

On macOS and Linux, the process runs every 30 seconds by default and stays alive after the starting terminal closes. `status` reports whether the process is running plus each configured Project/Adapter's last success time, current failure reason, and latest bounded counters. It does not expose conversation bodies. The v0.1 managed process does not promise restart after logout or reboot; an external supervisor may still invoke `collect --once` when boot persistence is required. Windows retains foreground `collect` until ATape can verify managed process ownership without relying on a reusable PID alone.

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
3. Redact each complete Adapter Raw segment, divide it into bounded 256 KiB transport chunks, and append them through the separate Raw endpoint.
4. Persist the source/server offset after every complete Adapter segment while leaving the Adapter cursor unchanged.
5. Atomically advance the opaque Adapter cursor only after the complete page succeeds.

If Raw fails after Canonical succeeds, the cursor remains unchanged. The next cycle replays the Canonical batch, skips Raw source bytes already recorded in the local progress checkpoint, and resumes at the first unacknowledged segment. If the server accepted a segment immediately before the client lost power, its deterministic identity makes that final replay safe. Source deletion never sends a delete to ATape.

## Local state and v0.1 migration

All default client data lives below `ATAPE_HOME`, which defaults to `~/.atape`:

- Credentials: `~/.atape/credentials/`
- Configuration: `~/.atape/config/client.json`
- Collector checkpoints, process metadata, and status: `~/.atape/state/`
- Background logs: `~/.atape/logs/collector.log`
- Adapter packages: `~/.atape/adapters/`

`ATAPE_HOME` relocates the whole layout. Individual `ATAPE_CONFIG_FILE`, `ATAPE_COLLECTOR_STATE_FILE`, `ATAPE_COLLECTOR_PROCESS_FILE`, `ATAPE_COLLECTOR_STATUS_FILE`, `ATAPE_COLLECTOR_LOG_FILE`, and `ATAPE_ADAPTER_DIRECTORY` overrides remain available for development. Credentials use opaque per-Instance filenames, owner-only directories/files, no-follow reads, compare-and-swap updates, and fsynced atomic replacement. Local filesystem paths remain client state and are not part of server Project, Canonical, Raw, or Search payloads.

v0.2 never silently adopts v0.1 XDG data. Preview and explicitly archive it while retaining every original:

```sh
pnpm atape migrate-local-v0.1
pnpm atape migrate-local-v0.1 --apply
```

The import deliberately discards old client-asserted server/User/Team/Project authority. An old checkpoint can be adopted only later, after authenticated setup has bound exactly one new Instance/User/Project/Adapter tuple, with the explicit `--adopt-checkpoint` command shown by `atape --help`.

The checkpoint file stores only an installation ID, opaque cursors, and per-Raw-object offsets; it never queues conversation bodies. Raw content is re-read from the Harness through an unadvanced cursor after a failed upload, while acknowledged source ranges are skipped.

The redactor covers common credentials and environment values whose names end in `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `CREDENTIAL`, `DATABASE_URL`, or `DSN`. Add exact values with a JSON array in `ATAPE_REDACT_VALUES`. Identity fields are stable and are not rewritten, so Adapter authors must never place secrets in IDs.

Every listing command supports `--json` for scripts.

The executable package contract is documented in [Adapter package and runtime contract](../adapters/package-manifest.md). Provider-specific behavior is documented in the [Codex Adapter guide](../adapters/codex.md).
