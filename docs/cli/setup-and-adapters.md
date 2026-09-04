# Local setup and Adapter management

The ATape CLI keeps capture authorization explicit and local. `setup` records which directories may be observed, Adapter commands manage independently installed Harness integrations, and `collect` runs the bounded upload workflow.

## Configure a Project

Run setup from a Project directory:

```sh
pnpm atape setup --user-id liying --team-id acme-engineering
```

Or provide the directory and complete identity explicitly:

```sh
pnpm atape setup ../payments-api \
  --user-id liying \
  --team-id acme-engineering \
  --team-name "Acme Engineering" \
  --project-id payments-api \
  --name "Payments API" \
  --server http://127.0.0.1:8080
```

The default `--type auto` behavior promotes a path inside a Git worktree to the repository root and records a `git` Project. Use `--type directory` when the selected folder itself is the intended boundary, even when it sits inside a Git repository. `--type git` rejects paths outside a Git worktree.

The Team user ID is client-wide and immutable. Project ID, Team, name, type, and resolved path form the local capture identity. Repeating an identical setup is idempotent. To change Project identity, remove the local Project and set it up again:

```sh
pnpm atape projects list
pnpm atape projects remove payments-api
```

Removal only changes this machine's configuration. It never deletes conversation history already captured by the ATape server.
If the same Project ID is registered again later, its new local creation timestamp starts a fresh Adapter cursor and Raw checkpoint. Existing server history is still retained and ingestion identities remain idempotent.

## Install and assign Adapters

An Adapter may come from the npm registry or a local package directory:

```sh
pnpm atape adapters install @atape/adapter-codex
pnpm atape adapters install ../atape-adapter-custom
```

While developing this repository, install its first-party Codex Adapter directly:

```sh
pnpm atape adapters install ./adapters/codex
```

Installation validates the package manifest without importing its source and disables npm lifecycle scripts. A package must therefore publish ready-to-run output. Installing an Adapter does not start a process.

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

Bulk upgrades run sequentially because the packages share one isolated npm installation tree. Locally installed packages keep their local source path as the upgrade source.

## Run collection

Run one bounded cycle for diagnosis or an external scheduler:

```sh
pnpm atape collect --once
pnpm atape collect --once --project payments-api --json
```

Run continuously at the default 30-second interval, or select an interval between 10 seconds and one hour:

```sh
pnpm atape collect
pnpm atape collect --interval 10 --concurrency 4
```

The Collector runs at most four Project/Adapter jobs concurrently by default and caps the value at eight. Within each job it pulls bounded pages sequentially. `Ctrl+C` and `SIGTERM` interrupt Adapter work and release loaded runtimes.

Each page follows this commit order:

1. Validate the Adapter output and apply client-side secret redaction.
2. Commit each Canonical Session observation and receive its stable server Session ID.
3. Redact each complete Adapter Raw segment, divide it into bounded 256 KiB transport chunks, and append them through the separate Raw endpoint.
4. Persist the source/server offset after every complete Adapter segment while leaving the Adapter cursor unchanged.
5. Atomically advance the opaque Adapter cursor only after the complete page succeeds.

If Raw fails after Canonical succeeds, the cursor remains unchanged. The next cycle replays the Canonical batch, skips Raw source bytes already recorded in the local progress checkpoint, and resumes at the first unacknowledged segment. If the server accepted a segment immediately before the client lost power, its deterministic identity makes that final replay safe. Source deletion never sends a delete to ATape.

## Local state

The default locations follow XDG conventions:

- Configuration: `$XDG_CONFIG_HOME/atape/config.json`, or `~/.config/atape/config.json`
- Collector checkpoints: `$XDG_STATE_HOME/atape/collector.json`, or `~/.local/state/atape/collector.json`
- Adapter packages: `$XDG_DATA_HOME/atape/adapters`, or `~/.local/share/atape/adapters`

`ATAPE_CONFIG_FILE`, `ATAPE_COLLECTOR_STATE_FILE`, and `ATAPE_ADAPTER_DIRECTORY` override those paths for development and deployment. Configuration and checkpoint writes are atomic, concurrency-safe, and owner-only. Local filesystem paths remain client state and are not part of server Project, Canonical, Raw, or Search payloads.

The checkpoint file stores only an installation ID, opaque cursors, and per-Raw-object offsets; it never queues conversation bodies. Raw content is re-read from the Harness through an unadvanced cursor after a failed upload, while acknowledged source ranges are skipped.

The redactor covers common credentials and environment values whose names end in `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `CREDENTIAL`, `DATABASE_URL`, or `DSN`. Add exact values with a JSON array in `ATAPE_REDACT_VALUES`. Identity fields are stable and are not rewritten, so Adapter authors must never place secrets in IDs.

Every listing command supports `--json` for scripts.

The executable package contract is documented in [Adapter package and runtime contract](../adapters/package-manifest.md). Provider-specific behavior is documented in the [Codex Adapter guide](../adapters/codex.md).
