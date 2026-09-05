# ATape

ATape is a project-first shared history for coding-agent conversations. It lets a team follow active work, replay prior decisions, and inspect captured subagent threads without changing each member's preferred harness CLI.

The first vertical slices implement **Workspace → Project Memory → Session Reader**, **Keyword Search → Exact Event replay**, and an explicitly opened **Raw source drawer** against a real Go API. The Workspace supports multiple Teams and typed Git-repository or ordinary-directory Projects. Canonical conversation data, Raw source data, and the Search read model use separate APIs and storage paths.

Reusable visual primitives, semantic tokens, and themes live in [`packages/ui`](packages/ui/README.md). Product pages consume that package while keeping their business-specific composition local to the Web app.

## Self-host with Docker

Requirements: Docker Engine and Docker Compose v2.

Start a durable local ATape deployment:

```sh
docker compose up --build -d
```

Open [http://127.0.0.1:8080/](http://127.0.0.1:8080/). The same URL is the Server address passed to `atape setup`. PostgreSQL metadata and Raw source bytes live in separate named volumes and survive ordinary container recreation.

The Web root opens the most recently captured Project. Before the first successful collection, it presents the CLI-first setup flow instead of redirecting to demo data.

The defaults bind only to localhost and use a development database password. Copy [`.env.example`](.env.example) to `.env` before changing the port, bind address, or password. ATape v0.1 does not yet provide authentication or TLS; do not bind it publicly unless an authenticating TLS reverse proxy or equivalent trusted-network boundary protects it.

Inspect startup and migration progress with `docker compose logs -f server`, and stop the deployment without deleting retained volumes with:

```sh
docker compose down
```

## Run locally

Requirements: Node.js 24+, pnpm 11, and Go 1.24+. PostgreSQL is optional for the seeded UI demo and required for durable Canonical storage.

Install dependencies:

```sh
pnpm install --frozen-lockfile
```

Start the Go server with explicitly enabled in-memory demo data:

```sh
pnpm dev:server
```

`pnpm dev:server` sets `ATAPE_DEMO_MODE=true`. A direct server process without `ATAPE_DATABASE_URL` otherwise refuses to start, preventing accidental ephemeral production history. To use durable Canonical, Search, and Raw manifest storage, provide a PostgreSQL connection string and an explicit Raw chunk directory; embedded forward migrations complete before the HTTP listener starts:

```sh
ATAPE_DATABASE_URL='postgres://atape:atape@127.0.0.1:5432/atape?sslmode=disable' \
ATAPE_RAW_DIRECTORY='/var/lib/atape/raw' \
pnpm dev:server
```

A PostgreSQL deployment without `ATAPE_RAW_DIRECTORY` still serves Canonical and Search data, but Raw uploads and byte reads return `503` rather than falling back to process-local storage.

In a second terminal, start the Web app:

```sh
pnpm dev:web
```

Open [http://127.0.0.1:4187/](http://127.0.0.1:4187/).

Configure local capture Projects and independently installed Harness Adapters with the Node/Effect CLI:

```sh
ATAPE_DEVELOPMENT_ALLOW_HTTP=true pnpm atape login --instance http://127.0.0.1:8080 --no-browser
pnpm atape adapters install ./adapters/codex
pnpm atape setup /path/to/project --team acme-engineering --create --adapter codex
pnpm atape start
pnpm atape status
```

The loopback command also requires `ATAPE_DEVELOPMENT_ALLOW_HTTP=true`; production and self-hosted Instances are HTTPS-only. `start` launches one managed Collector that keeps running after the terminal closes. It dynamically loads only enabled Adapters, redacts secrets, commits Canonical and Raw independently, and advances local cursors only after both succeed. Use `stop` to end it; use `collect --once` for a foreground diagnostic cycle. See the [Codex Adapter guide](docs/adapters/codex.md), [`docs/cli/setup-and-adapters.md`](docs/cli/setup-and-adapters.md), and the [`Adapter package and runtime contract`](docs/adapters/package-manifest.md).

Build and verify the installable, zero-runtime-dependency CLI and Codex Adapter tarballs with:

```sh
pnpm test:release
pnpm pack:release
npm install --global ./release/atape-cli-0.1.0.tgz
atape adapters install ./release/atape-adapter-codex-0.1.0.tgz
atape --version
```

The public npm packages use the `@atape` scope:

```sh
npm install --global @atape/cli
atape adapters install @atape/adapter-codex
```

The release directory also contains `SHA256SUMS`. Tag-driven publication is documented in [`docs/releasing.md`](docs/releasing.md).

## Verify

```sh
pnpm check
pnpm build
```

`pnpm check` includes an isolated cross-process E2E test that starts the real Go server and drives the Node Collector with the Codex Adapter through Canonical ingestion, Search projection, Raw chunking, incremental append, archive finalization, and provider-source deletion. It reuses the workspace Adapter package and does not install anything from npm. Run only that boundary with:

```sh
pnpm test:e2e
```

Run the real PostgreSQL Adapter contract and restart-durability suite when Docker is available:

```sh
pnpm test:go:integration
```

Regenerate the private pgx query package after changing a migration or query:

```sh
pnpm generate:sqlc
```

## Architecture

Read [`docs/architecture/README.md`](docs/architecture/README.md) before changing production code. The Web runtime decision is recorded in [`ADR-0001`](docs/architecture/adr/0001-web-runtime-and-view-stack.md).

The authenticated browser/CLI boundary is documented in [`docs/api/authentication-http.md`](docs/api/authentication-http.md), with its complete OpenAPI 3.1 contract in [`docs/api/openapi-v1.yaml`](docs/api/openapi-v1.yaml). The ingestion envelopes are documented in [`docs/api/canonical-ingestion.md`](docs/api/canonical-ingestion.md) and [`docs/api/raw-archive.md`](docs/api/raw-archive.md). Read APIs are documented in [`docs/api/workspace.md`](docs/api/workspace.md) and [`docs/api/project-search.md`](docs/api/project-search.md). Client runtime decisions are recorded in [`ADR-0008`](docs/architecture/adr/0008-node-cli-and-on-demand-adapters.md) and [`ADR-0009`](docs/architecture/adr/0009-pull-adapter-runtime-and-checkpointed-collector.md).

## License

ATape is available under the [MIT License](LICENSE).
