# ADR-0010: Compose Self-Hosting Topology

- Status: Accepted
- Date: 2026-09-05

> Authentication statements in this ADR describe the v0.1 topology. The v0.2
> HTTP security boundary is defined by
> [ADR-0017](0017-http-interface-and-route-security.md); its deployable
> configuration and data cutover are intentionally handled separately.

## Context

ATape's first vertical slices work across the Web application, Go API, PostgreSQL persistence, filesystem Raw chunks, and the Node Collector. A team still has to assemble and route those pieces manually before it can dogfood the product. The v0.1 self-hosting path needs one command, durable defaults, same-origin browser API calls, and a clear boundary between development demo data and retained team history.

ATape does not yet implement authentication or TLS. A default deployment must therefore avoid silently exposing every Team's Canonical and Raw data on a public interface.

## Considered Designs

### Embed the Web build into the Go binary

One artifact would simplify runtime deployment, but it would couple the Go image build to the Web output and make static delivery, cache policy, and same-origin proxy behavior part of the API executable.

### Run a Node production Web server beside Go

This preserves a JavaScript runtime around the Web build, but the current application is static after Vite compilation. Keeping Node in production adds memory and lifecycle cost without adding product behavior.

### Put a static reverse proxy in front of Go

A small edge container can serve the Vite output, route `/api/` and `/healthz` to Go, enforce an upload-body ceiling compatible with ATape's bounded protocols, and expose one same-origin endpoint. Go, PostgreSQL, and Raw storage retain their existing ownership boundaries.

## Decision

ATape v0.1 provides a root `compose.yaml` with four runtime concerns:

- `web` is the only published service. Nginx serves the compiled Vite application and proxies API and health requests to Go on the private Compose network.
- `server` runs the statically built Go executable. Embedded forward migrations finish before its listener starts.
- `database` runs PostgreSQL with a named durable volume for Canonical, Search, Raw manifests, and ingestion receipts.
- a separate named volume is mounted at `ATAPE_RAW_DIRECTORY` for immutable Raw chunk bytes. Raw bytes are not stored in PostgreSQL or joined into Canonical reads.

The default published address is `127.0.0.1:8080`. Operators may change the bind address and port through `.env`, but exposing ATape beyond a trusted machine or network requires an external authenticating TLS reverse proxy until product authentication exists.

Production server startup requires `ATAPE_DATABASE_URL`. The seeded in-memory Adapter is available only when `ATAPE_DEMO_MODE=true` is explicit. `pnpm dev:server` supplies that flag for local UI development; the Compose deployment sets it to false.

Container images are split by responsibility: a minimal Alpine Go runtime owns the API process and Raw mount, while an Nginx image contains only static Web output and proxy configuration. Image builds remain reproducible from the repository lockfiles; runtime containers do not install packages.

## Consequences

- `docker compose up --build -d` creates a complete durable ATape deployment with one browser/CLI origin.
- Server, database, and Raw storage stay private to the Compose network by default.
- PostgreSQL and Raw data survive ordinary container recreation through named volumes.
- Web and API can scale or be replaced independently without changing application routes.
- The reverse proxy accepts at most 5 MiB request bodies, remaining above current Canonical and Raw wire limits while bounding proxy memory and disk buffering.
- Built-in authentication, TLS termination, backups, remote object storage, and zero-downtime multi-replica rollout remain outside this v0.1 topology.

## Rejected Alternatives

- **Go-embedded SPA**: reduces container count but couples independent build and delivery concerns into the API binary.
- **Node static server**: retains an unnecessary application runtime after Vite compilation.
- **Expose Go and Web separately**: creates CORS and configuration work for browsers and gives CLI users a different endpoint from the UI.
- **Bind publicly by default**: unsafe while all Team members can read Canonical and Raw data and no authentication boundary exists.
