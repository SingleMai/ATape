# ATape

ATape is a project-first shared history for coding-agent conversations. It lets a team follow active work, replay prior decisions, and inspect captured subagent threads without changing each member's preferred harness CLI.

The first vertical slices implement **Workspace → Project Memory → Session Reader**, **Global Search → Exact Event replay**, and an explicitly opened **Raw source drawer** against a real Go API. The Workspace supports multiple Teams and typed Git-repository or ordinary-directory Projects. Canonical conversation data, Raw source data, and the Search read model use separate APIs and storage paths.

The workspace now centers on a compact Project sidebar and a clean Session reader. Global Search opens with **Cmd/Ctrl+K**, with Team/Project scope, retained result state, and exact-message navigation. See the [workspace and Search guide](docs/workspace-search.md) for behavior and current limits.

Reusable visual primitives, semantic tokens, and themes live in [`packages/ui`](packages/ui/README.md). Product pages consume that package while keeping their business-specific composition local to the Web app.

Use the [documentation index](docs/README.md) to find feature guides, API contracts
and operations, or the [development guide](docs/development.md) for the code map
and checks relevant to a change.

## Start capturing conversations

Use an existing ATape Instance with Node.js 24+ and a macOS or Linux terminal:

```sh
npm install --global @atape/cli
atape --version
atape
```

Run `atape` from the Project directory you want to connect. Choose your tools,
sign in, create or join a Team if needed, and review the destination and historical
import before confirming. The default Instance is `https://atape.net`; use
Settings → Change server for your own Instance.

The [setup guide](docs/cli/setup-and-adapters.md) covers supported sources,
[first-sync verification](docs/cli/setup-and-adapters.md#confirm-the-first-sync),
[upgrades](docs/cli/setup-and-adapters.md#upgrade-the-cli-and-adapters) and
[recovery](docs/cli/setup-and-adapters.md#troubleshooting). Source checkout and
Docker are needed only if you develop or self-host ATape.

## Self-host with Docker

Requirements: Docker Engine, Docker Compose v2, OpenSSL and a GitHub OAuth App.
Follow the [self-hosting quick start](docs/operations/self-hosting.md#first-installation)
for the exact callback URL and Provider configuration before starting Compose.

Start a durable local ATape deployment:

```sh
cp .env.example .env
./scripts/generate-self-hosted-secrets.sh ./secrets
# Set the GitHub Client ID in .env and write its OAuth App secret to
# ./secrets/github_client_secret with mode 0600.
docker compose up --build -d
```

Open [http://127.0.0.1:8080/](http://127.0.0.1:8080/). The same URL is the Server address entered in ATape Settings. PostgreSQL metadata and Raw source bytes live in separate named volumes and survive ordinary container recreation.

The Web root opens the most recently captured Project. Before the first successful collection, it presents the CLI-first setup flow instead of redirecting to demo data.

The defaults bind only to localhost and permit HTTP only for that explicit loopback origin. Production uses a configured HTTPS origin behind an operator-owned TLS/WAF edge. Database credentials, authentication key rings, and the GitHub Client Secret are mounted as files rather than expanded into the Compose environment. See the [self-hosting guide](docs/operations/self-hosting.md), [backup/restore runbook](docs/operations/backup-and-restore.md), and [v0.1.1 authenticated cutover](docs/operations/auth-cutover.md).

Inspect startup and migration progress with `docker compose logs -f server`, and stop the deployment without deleting retained volumes with:

```sh
docker compose down
```

## Run locally

Requirements: Node.js 24+ and the pnpm version pinned in [package.json](package.json),
plus the Go toolchain declared in [server/go.mod](server/go.mod). PostgreSQL is
optional for the seeded UI demo and required for durable Canonical storage.

Install dependencies:

```sh
pnpm install --frozen-lockfile
```

Start the Go server with explicitly enabled in-memory demo data:

```sh
pnpm dev:server
```

`pnpm dev:server` sets `ATAPE_DEMO_MODE=true`. This seeded, loopback-only UI mode deliberately bypasses the production Authentication Module and cannot be combined with durable PostgreSQL. A production process requires PostgreSQL, a writable Raw directory, canonical public origins, authentication key rings, and at least one active Provider registration; it fails before listening rather than falling back to ephemeral or partially configured state. Use the Compose path above for an end-to-end local authenticated Instance.

In a second terminal, start the Web app:

```sh
pnpm dev:web
```

Open [http://127.0.0.1:4187/](http://127.0.0.1:4187/).

For CLI development, use the authenticated Compose Instance; the seeded demo
cannot complete CLI sign-in. Create or join a Team in its Web app first, then use
the terminal application:

```sh
export ATAPE_DEVELOPMENT_ALLOW_HTTP=true
export ATAPE_INSTANCE_URL=http://127.0.0.1:8080
pnpm --filter @atape/adapter-codex build
pnpm atape --no-browser
```

For the local Adapter build, open Tools and updates → Integration maintenance and
install `./adapters/codex`, then choose it in Choose tools to sync. On a fresh
installation you can save an empty tool selection to reach the Project console
before installing local packages. Add project connects the chosen directory after
sign-in and review. Keep the loopback environment setting for later local sessions;
production Instances use HTTPS.

Background sync continues after the terminal closes. Start it from Home and stop
it in Settings. Projects shows sync details and recovery. Codex/Claude advance page
cursors after Canonical and Raw deliveries succeed; OpenCode atomically publishes
Canonical targets and recovers Raw independently. See the [CLI guide](docs/cli/setup-and-adapters.md)
and [Adapter contract](docs/adapters/package-manifest.md) for supported behavior.

Build and verify the installable, zero-runtime-dependency CLI and Codex/Claude/OpenCode Adapter tarballs with:

```sh
pnpm test:release
pnpm pack:release
ATAPE_PACKAGE_VERSION=$(node -p 'require("./package.json").version')
npm install --global "./release/atape-cli-${ATAPE_PACKAGE_VERSION}.tgz"
atape --version
atape
```

Install the Adapter tarball from Integration maintenance using its full path.
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

Run the real PostgreSQL, authentication, cutover, HTTP, and Team integration suites when Docker is available:

```sh
pnpm test:go:integration
pnpm test:self-hosting:config
```

The full paired PostgreSQL + Raw recovery rehearsal is intentionally separate
because it builds containers and creates then destroys isolated volumes:

```sh
pnpm test:self-hosting:restore
```

Regenerate the private pgx query package after changing a migration or query:

```sh
pnpm generate:sqlc
```

## Architecture

Read [`docs/architecture/README.md`](docs/architecture/README.md) before changing production code. The Web runtime decision is recorded in [`ADR-0001`](docs/architecture/adr/0001-web-runtime-and-view-stack.md).

The authenticated browser/CLI boundary is documented in [`docs/api/authentication-http.md`](docs/api/authentication-http.md), with its complete OpenAPI 3.1 contract in [`docs/api/openapi-v1.yaml`](docs/api/openapi-v1.yaml). The authenticated deployment and data transition are recorded in [`ADR-0018`](docs/architecture/adr/0018-auth-cutover-and-deployable-self-hosting.md). The ingestion envelopes are documented in [`docs/api/canonical-ingestion.md`](docs/api/canonical-ingestion.md) and [`docs/api/raw-archive.md`](docs/api/raw-archive.md). Read APIs are documented in [`docs/api/workspace.md`](docs/api/workspace.md) and [`docs/api/project-search.md`](docs/api/project-search.md). Client runtime decisions are recorded in [`ADR-0008`](docs/architecture/adr/0008-node-cli-and-on-demand-adapters.md) and [`ADR-0009`](docs/architecture/adr/0009-pull-adapter-runtime-and-checkpointed-collector.md).

## License

ATape is available under the [MIT License](LICENSE).
