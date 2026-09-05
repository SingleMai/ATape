# Self-hosting ATape v0.2

The repository contains every runtime component needed for an ATape Instance:
the static Web application, Go server, PostgreSQL, and filesystem Raw storage.
No request in the core login, CLI, Workspace, capture, read, Search, backup, or
restore flow depends on `atape.dev` or another ATape-operated service.

## Choose one public topology

The default and recommended topology is same-origin:

```text
https://atape.example.com ── TLS/WAF ──> 127.0.0.1:8080 (Web + /api proxy)
```

The official hosted Instance will use `https://atape.dev` in this shape. For a
self-hosted domain, replace it with the operator-owned origin. The Go server
does not trust request `Host`, `Forwarded`, or `X-Forwarded-*` when deriving
callbacks, redirects, CORS, or Cookies; the configured public origins are the
authority.

A split-origin installation is also supported:

```text
https://app.example.com ── TLS/WAF ──> 127.0.0.1:8080 (Web)
https://api.example.com ── TLS/WAF ──> 127.0.0.1:8081 (API)
```

Set `ATAPE_API_PUBLIC_URL=https://api.example.com`, set the single shared
`ATAPE_COOKIE_DOMAIN=example.com`, and include `-f compose.split-origin.yaml`.
Both published Compose ports remain loopback by default. There is no reason to
configure multiple Cookie domains. The Web virtual host serves only the public
Instance-discovery endpoint below `/api`; credential-bearing calls are not
aliased and must reach the configured API virtual host.

Plain HTTP is accepted only for `localhost`, `127.0.0.1`, or `::1` when
`ATAPE_DEVELOPMENT_ALLOW_HTTP=true`. It is not a production topology.

## First installation

Requirements are Docker Engine, Docker Compose v2, and OpenSSL. Create a GitHub
OAuth App whose callback is exactly:

```text
<ATAPE_API_PUBLIC_URL-or-ATAPE_PUBLIC_URL>/api/v1/auth/github/callback
```

Then prepare configuration without putting secrets in `.env`:

```sh
cp .env.example .env
./scripts/generate-self-hosted-secrets.sh ./secrets
umask 077
${EDITOR:-vi} ./secrets/github_client_secret
chmod 600 ./secrets/github_client_secret
```

Edit `.env` to set the canonical public URL, GitHub Client ID, and topology.
Write the OAuth App secret followed by a newline into
`./secrets/github_client_secret`; do not put it on a command line or in `.env`.
For public deployment, change the URL to HTTPS and set
`ATAPE_DEVELOPMENT_ALLOW_HTTP=false`.

Validate and start the same-origin stack:

```sh
docker compose config --quiet
docker compose up --build -d
curl --fail https://atape.example.com/readyz
```

For split-origin, consistently add the override to lifecycle commands:

```sh
docker compose -f compose.yaml -f compose.split-origin.yaml config --quiet
docker compose -f compose.yaml -f compose.split-origin.yaml up --build -d
```

The database and Raw byte tree use separate named volumes. `web` is the only
published service in the default topology. `/healthz` reports process liveness;
`/readyz` checks the cutover/database state and performs a bounded durable-write
probe through the configured Raw Chunk Store Adapter. Compose waits on
readiness, not merely liveness.

## Secrets and rotation

Compose mounts five files:

- a PostgreSQL password and the matching internal database URL;
- the authentication pepper key ring;
- the private-state encryption key ring;
- the GitHub Client Secret.

The generated authentication rings are JSON documents with an active key ID.
To rotate one, add a new 32-byte base64 key under a new ID, make that ID active,
and restart the server. Keep older referenced keys until the corresponding
Sessions, authorization codes, or login transactions have expired or been
revoked. Startup fails if the database still references a key or Provider
revision that the process cannot serve.

Secret files are intentionally absent from PostgreSQL + Raw backups. Preserve
them separately in encrypted off-host storage. `generate-self-hosted-secrets.sh`
refuses to overwrite an existing target.

## Network boundary

Terminate TLS before the loopback Compose ports. Apply host-level firewalling,
WAF policy, request-rate limiting, and volumetric protection there. ATape still
enforces exact Origin/CSRF, credential ambiguity, code-attempt bounds, body
limits, authorization, and application-level polling backoff; it does not try
to replace an Internet edge.

Do not publish PostgreSQL, the Go server's private Compose port, or a split API
port directly to the Internet. Forward only from the intended TLS virtual host.

## Routine operations

```sh
docker compose logs -f server
docker compose ps
docker compose down
```

`docker compose down` retains named volumes. Never add `--volumes` unless the
explicit goal is to destroy retained PostgreSQL and Raw data.

Before upgrading or rotating data-bearing infrastructure, follow
[Backup and restore](backup-and-restore.md). A v0.1.1 database additionally
requires the [authenticated cutover runbook](auth-cutover.md).
