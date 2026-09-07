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
| [0018](0018-auth-cutover-and-deployable-self-hosting.md) | Accepted | Durable reviewed auth cutover, fail-closed serving modes, secret-file Compose, and paired PostgreSQL + Raw recovery |
| [0019](0019-low-cost-dogfood-egress.md) | Accepted | Time-bounded HTTPS and Cloudflare Tunnel egress for the disposable AWS dogfood host |
| [0020](0020-claude-source-conversation-topology.md) | Accepted | Active-path Claude projection, conservative continuation merging, self-contained forks, and child subagent Threads |
| [0021](0021-claude-origin-project-attribution.md) | Accepted | Origin-based Claude Project attribution across worktrees, directory changes, and transcript relocation |
| [0022](0022-atomic-canonical-publication.md) | Accepted design; Implementation pending | Provider-neutral staged Canonical targets, conditional atomic activation, recovery receipts and head-consistent reads/Search |
| [0023](0023-bounded-raw-byte-streams.md) | Accepted design; Implementation pending | Bounded Raw byte frames, versioned cross-frame masking, deterministic packing and metadata-only replay |
| [0024](0024-transactional-capture-checkpoints.md) | Accepted design; Implementation pending | Transactional metadata-only capture journal, explicit source coverage and independently fenced Raw recovery |
| [0025](0025-shared-acp-tool-values-and-source-references.md) | Accepted design; Implementation pending | End-to-end common ACP tool values, deterministic v2 encoding and generation-specific pending Raw references |

ADRs record consequential implementation decisions. A superseded ADR remains in the repository and links to its replacement.

[ADR-0026](0026-claude-first-vertical-slice.md) records the user-directed switch to a first production Claude vertical slice on existing Interfaces, with the broader planned protocols deferred.

[ADR-0027](0027-bounded-tool-details-implementation.md) implements bounded shared tool values with a versioned profile, Canonical persistence, Host redaction and common rendering; the remaining ADR-0025 work stays deferred.
