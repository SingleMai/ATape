# Architecture Decision Records

[ADR-0058](0058-opencode-sqlite-and-bounded-capture.md) records the accepted
OpenCode read-only SQLite route and scoped permission for bounded pending
content; the detailed capture contract and Implementation remain pending.

[ADR-0057](0057-team-overview-and-structured-usage.md) adds structured Canonical
usage, authorized Team aggregation and the management Overview.

[ADR-0049](0049-empty-collector-page-progress.md) accepts bounded empty-page
continuations that advance the cursor without fabricating uploaded observations.

[ADR-0046](0046-v0.4.5-manual-release-waiver.md) records the explicitly authorized,
candidate-bound v0.4.5 manual staging waiver; automated gates remain required.

[ADR-0045](0045-v0.4.4-manual-release-waiver.md) records the explicitly authorized,
candidate-bound v0.4.4 manual staging waiver; all automated gates remain required.

[ADR-0044](0044-cli-self-upgrade.md) records npm-owned CLI self-upgrade and
cached startup Upgrade/Skip selection.

[ADR-0043](0043-v0.4.2-manual-release-waiver.md) records the separately authorized,
candidate-bound v0.4.2 manual staging waiver; automated gates remain required.

[ADR-0042](0042-v0.4.1-manual-release-waiver.md) records the separately authorized,
candidate-bound v0.4.1 manual staging waiver.

[ADR-0041](0041-v0.4.0-manual-release-waiver.md) records the separately authorized,
candidate-bound v0.4.0 manual staging waiver.

[ADR-0040](0040-global-cli-tools.md) records global CLI tool configuration,
one current configuration schema and shared Collector semantics.

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
| [0020](0020-derived-conversation-narrative.md) | Accepted | Non-persisted Narrative Exchanges derived from Canonical Events for readable conversation views |
| [0021](0021-provider-session-titles-and-search-invalidation.md) | Accepted | Provider-authored Session titles with deterministic fallback, Cursor backfill, and Search invalidation |
| [0022](0022-canonical-priority-and-larger-raw-chunks.md) | Accepted | Canonical-priority collection with resumable Raw backfill and three MiB transport chunks |
| [0023](0023-claude-source-conversation-topology.md) | Accepted | Active-path Claude projection, conservative continuation merging, self-contained forks, and child subagent Threads |
| [0024](0024-claude-origin-project-attribution.md) | Accepted | Origin-based Claude Project attribution across worktrees, directory changes, and transcript relocation |
| [0025](0025-atomic-canonical-publication.md) | Accepted design; Implementation pending | Provider-neutral staged Canonical targets, conditional atomic activation, recovery receipts and head-consistent reads/Search |
| [0026](0026-bounded-raw-byte-streams.md) | Accepted design; Implementation pending | Bounded Raw byte frames, versioned cross-frame masking, deterministic packing and metadata-only replay |
| [0027](0027-transactional-capture-checkpoints.md) | Accepted design; Implementation pending | Transactional metadata-only capture journal, explicit source coverage and independently fenced Raw recovery |
| [0028](0028-shared-acp-tool-values-and-source-references.md) | Accepted design; Implementation pending | End-to-end common ACP tool values, deterministic v2 encoding and generation-specific pending Raw references |
| [0036](0036-ink-cli-experience.md) | Accepted; implemented and verified locally | Ink setup and Project console over shared Effect workflows, with installed-artifact terminal validation |
| [0037](0037-shared-git-source-attribution.md) | Accepted; implemented locally | Shared Host Git attribution, repository-based reattachment and durable source evidence for Codex/Claude |

ADRs record consequential implementation decisions. A superseded ADR remains in the repository and links to its replacement.

[ADR-0034](0034-v0.2.0-manual-release-waiver.md) records the user-authorized,
candidate-bound v0.2.0 manual staging waiver without changing automated gates or
pretending that staging acceptance passed.

[ADR-0029](0029-claude-first-vertical-slice.md) records the user-directed switch to a first production Claude vertical slice on existing Interfaces, with the broader planned protocols deferred.

[ADR-0030](0030-bounded-tool-details-implementation.md) implements bounded shared tool values with a versioned profile, Canonical persistence, Host redaction and common rendering; the remaining ADR-0028 work stays deferred.

[ADR-0031](0031-source-failure-isolation.md) isolates individual Claude sources and adds bounded, redacted local diagnostics to the shared Collector Interface.

[ADR-0032](0032-claude-release-and-recovery.md) adds Claude release artifacts and resumes supported checkpoint formats across package replacement without resetting source progress.

[ADR-0033](0033-continuous-dogfood-web-deployment.md) deploys verified main commits to the dogfood Web container through a narrow SSM Interface, with rollback and retained lazy-load assets.

[ADR-0035](0035-global-search-workspace.md) adds a persistent global Search dialog and bounded cross-project queries through the existing Search Module.
| [0038](0038-v0.3.0-manual-release-waiver.md) | Accepted by explicit user authorization | Separate candidate-bound v0.3.0 manual staging waiver; all automated gates remain blocking |
| [0039](0039-v0.3.1-manual-release-waiver.md) | Accepted by explicit user authorization | Separate candidate-bound v0.3.1 manual staging waiver for CLI self-test; all automated gates remain blocking |

- [ADR-0047: Informational CLI device inventory](0047-cli-device-inventory.md)

- [ADR-0048: Release requests authorize manual acceptance waivers](0048-release-request-manual-acceptance.md)

- [ADR-0050: Bounded compressed Codex cursors](0050-bounded-compressed-codex-cursors.md)

- [ADR-0051: Codex paginated source attribution](0051-codex-paginated-source-attribution.md)

- [ADR-0052: Active Session collection scans](0052-active-session-collection-scans.md)

- [ADR-0053: Bounded collection of large archives](0053-large-archive-collection.md)

- [ADR-0054: Canonical replay across Adapter upgrades](0054-canonical-replay-provenance.md)

- [ADR-0055: Codex item updates across collection pages](0055-codex-item-update-revisions.md)

- [ADR-0056: Team and personal Raw capture policy](0056-configurable-raw-capture.md)
