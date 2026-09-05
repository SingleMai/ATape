# Architecture Decision Records

| ADR | Status | Decision |
| --- | --- | --- |
| [0001](0001-web-runtime-and-view-stack.md) | Accepted | Effect 4 RC, React 19, Vite 8, and TanStack Router for the v0.1 Web application |
| [0002](0002-ui-package-and-theming.md) | Accepted | `@atape/ui`, semantic CSS custom properties, and theme Adapters for reusable presentation |
| [0003](0003-canonical-ingestion-batches.md) | Accepted | Bounded idempotent Canonical batches with stable source identity and revision semantics |
| [0004](0004-postgresql-canonical-persistence.md) | Accepted | Consumer-owned persistence Seams backed by PostgreSQL, pgx, and sqlc |
| [0005](0005-canonical-search-read-model.md) | Accepted | Durable Canonical change feed and asynchronous project Search read model |
| [0006](0006-workspace-directory-and-project-types.md) | Accepted | Server-backed Workspace directory with immutable `git` and `directory` Project types |
| [0007](0007-raw-archive-chunks-and-generations.md) | Accepted | Separate Raw manifests and immutable bounded chunks with append generations |
| [0008](0008-node-cli-and-on-demand-adapters.md) | Accepted | Effect-powered Node CLI with atomic local config and on-demand npm Adapter packages |
| [0009](0009-pull-adapter-runtime-and-checkpointed-collector.md) | Accepted | Bounded pull Adapter runtime with redaction, separate Canonical/Raw commits, and CAS checkpoints |
| [0010](0010-compose-self-hosting-topology.md) | Accepted | Same-origin Compose self-hosting with Nginx, Go, PostgreSQL, and separate durable Raw storage |
| [0011](0011-managed-local-collector-and-session-presence.md) | Accepted | CLI-managed background collection, observable Project/Adapter status, and shared Session presence semantics |
| [0012](0012-single-bundle-cli-distribution.md) | Accepted | One installable CLI bundle with independently loaded Adapter packages and tarball-level release verification |
| [0013](0013-bounded-adapter-artifact-distribution.md) | Accepted | Bounded inert `.tgz`/HTTPS Adapter acquisition and separate checksummed CLI/Adapter release artifacts |
| [0014](0014-mit-and-tag-driven-package-publication.md) | Accepted | MIT licensing and recoverable tag-driven npm/GitHub publication from one verified artifact set |
| [0015](0015-authentication-module-and-secret-state.md) | Accepted | One deep Authentication Module with a narrow Federated Identity Adapter Seam and opaque secret persistence |
| [0016](0016-team-module-and-authoritative-resource-authorization.md) | Accepted | Deep Team control plane plus pure policy and authoritative per-Module resource authorization |
| [0017](0017-http-interface-and-route-security.md) | Accepted | Closed HTTP route classes, centralized transport security, RFC 9457, and OpenAPI drift checks |

ADRs record consequential implementation decisions. A superseded ADR remains in the repository and links to its replacement.
