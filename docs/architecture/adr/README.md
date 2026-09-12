# Architecture Decision Records

ADRs record the decision, scope, alternatives and consequences at the time of
writing. Acceptance is not proof that every proposed capability was implemented
or that a candidate was published. Follow amendment links and use the
[current documentation index](../../README.md) for supported behavior.

## Delivery context

- [CLI user journey](../../cli/user-journey.md) and
  [setup and Adapters](../../cli/setup-and-adapters.md) describe current CLI behavior.
- [OpenCode](../../adapters/opencode.md), the
  [capture contract](../opencode-capture-publication.md) and
  [Server publication](../publication-candidates.md) describe the selected
  implementation of ADR-0025/0058/0059 and subsequent decisions. This does not
  mark the broader byte-stream, metadata-only checkpoint or opaque-reference
  proposals in ADR-0026/0027/0028 as fully delivered.
- [Releasing](../../releasing.md) applies ADR-0048's standing authorization rule.
  Per-version waiver ADRs and candidate validation statements are historical
  evidence, not new approval requirements for each release.

## Decision index

Each record appears once below in numeric order. Read its own status and later
amendments for scope; keep delivery status in the relevant feature guide.

| ADR | Decision |
| --- | --- |
| [0001](0001-web-runtime-and-view-stack.md) | Web Runtime and View Stack |
| [0002](0002-ui-package-and-theming.md) | UI Package and Theming Boundary |
| [0003](0003-canonical-ingestion-batches.md) | Canonical Ingestion Batch Interface |
| [0004](0004-postgresql-canonical-persistence.md) | PostgreSQL Canonical Persistence Adapter |
| [0005](0005-canonical-search-read-model.md) | Canonical Search Read Model |
| [0006](0006-workspace-directory-and-project-types.md) | Workspace Directory and Project Types |
| [0007](0007-raw-archive-chunks-and-generations.md) | Raw Archive Chunks and Generations |
| [0008](0008-node-cli-and-on-demand-adapters.md) | Node CLI and On-Demand Adapter Packages |
| [0009](0009-pull-adapter-runtime-and-checkpointed-collector.md) | Pull Adapter Runtime and Checkpointed Collector |
| [0010](0010-compose-self-hosting-topology.md) | Compose Self-Hosting Topology |
| [0011](0011-managed-local-collector-and-session-presence.md) | Managed Local Collector and Session Presence |
| [0012](0012-single-bundle-cli-distribution.md) | Single-Bundle CLI Distribution |
| [0013](0013-bounded-adapter-artifact-distribution.md) | Bounded Adapter Artifact Distribution |
| [0014](0014-mit-and-tag-driven-package-publication.md) | MIT and Tag-Driven Package Publication |
| [0015](0015-authentication-module-and-secret-state.md) | Deep Authentication Module and Opaque Secret State |
| [0016](0016-team-module-and-authoritative-resource-authorization.md) | Team Module and Authoritative Resource Authorization |
| [0017](0017-http-interface-and-route-security.md) | Closed HTTP Interface and Route Security Contract |
| [0018](0018-auth-cutover-and-deployable-self-hosting.md) | Authenticated Cutover and Deployable Self-Hosting |
| [0019](0019-low-cost-dogfood-egress.md) | Low-Cost Dogfood Host Egress |
| [0020](0020-derived-conversation-narrative.md) | Derived Conversation Narrative |
| [0021](0021-provider-session-titles-and-search-invalidation.md) | Provider Session Titles and Search Invalidation |
| [0022](0022-canonical-priority-and-larger-raw-chunks.md) | Canonical-priority collection and larger Raw chunks |
| [0023](0023-claude-source-conversation-topology.md) | Claude Source Conversation Topology |
| [0024](0024-claude-origin-project-attribution.md) | Claude Origin Project Attribution |
| [0025](0025-atomic-canonical-publication.md) | Atomic Canonical Publication |
| [0026](0026-bounded-raw-byte-streams.md) | Bounded Raw Byte Streams |
| [0027](0027-transactional-capture-checkpoints.md) | Transactional Capture Checkpoints and Independent Raw Recovery |
| [0028](0028-shared-acp-tool-values-and-source-references.md) | Shared ACP Tool Values and Versioned Source References |
| [0029](0029-claude-first-vertical-slice.md) | Claude first implementation slice on the existing Collector |
| [0030](0030-bounded-tool-details-implementation.md) | Bounded shared tool details in the production pipeline |
| [0031](0031-source-failure-isolation.md) | Source failure isolation and local diagnostics |
| [0032](0032-claude-release-and-recovery.md) | Claude release artifacts and checkpoint recovery |
| [0033](0033-continuous-dogfood-web-deployment.md) | Continuous dogfood Web deployment |
| [0034](0034-v0.2.0-manual-release-waiver.md) | One-time v0.2.0 manual release waiver |
| [0035](0035-global-search-workspace.md) | Global Search workspace |
| [0036](0036-ink-cli-experience.md) | Ink CLI Experience and Shared Capture Workflows |
| [0037](0037-shared-git-source-attribution.md) | Shared Git Source Attribution |
| [0038](0038-v0.3.0-manual-release-waiver.md) | One-time v0.3.0 manual release waiver |
| [0039](0039-v0.3.1-manual-release-waiver.md) | One-time v0.3.1 manual release waiver |
| [0040](0040-global-cli-tools.md) | Global CLI tools |
| [0041](0041-v0.4.0-manual-release-waiver.md) | One-time v0.4.0 manual release waiver |
| [0042](0042-v0.4.1-manual-release-waiver.md) | One-time v0.4.1 manual release waiver |
| [0043](0043-v0.4.2-manual-release-waiver.md) | One-time v0.4.2 manual release waiver |
| [0044](0044-cli-self-upgrade.md) | CLI upgrade and startup update choice |
| [0045](0045-v0.4.4-manual-release-waiver.md) | One-time v0.4.4 manual release waiver |
| [0046](0046-v0.4.5-manual-release-waiver.md) | One-time v0.4.5 manual release waiver |
| [0047](0047-cli-device-inventory.md) | Informational CLI device and sync monitoring |
| [0048](0048-release-request-manual-acceptance.md) | Release requests authorize manual acceptance waivers |
| [0049](0049-empty-collector-page-progress.md) | Commit empty pages that advance collection |
| [0050](0050-bounded-compressed-codex-cursors.md) | Bounded compressed Codex cursors |
| [0051](0051-codex-paginated-source-attribution.md) | Attribute Codex paginated source files independently |
| [0052](0052-active-session-collection-scans.md) | Refresh only active sources on continuation pages |
| [0053](0053-large-archive-collection.md) | Bounded collection of large archives |
| [0054](0054-canonical-replay-provenance.md) | Canonical replay across Adapter upgrades |
| [0055](0055-codex-item-update-revisions.md) | Codex item updates across collection pages |
| [0056](0056-configurable-raw-capture.md) | Team and personal Raw capture policy |
| [0057](0057-team-overview-and-structured-usage.md) | Team Overview and structured usage |
| [0058](0058-opencode-sqlite-and-bounded-capture.md) | OpenCode SQLite acquisition and bounded pending capture |
| [0059](0059-opencode-publication-and-recovery.md) | OpenCode publication and recovery contract |
| [0060](0060-publication-raw-authority-and-receipts.md) | Independent Raw authority and immutable chunk receipts |
| [0061](0061-independent-raw-observations.md) | Independent fresh Raw observations |
| [0062](0062-source-record-versions-and-coverage.md) | Source record versions and independent coverage |
| [0063](0063-opencode-scoped-source-views.md) | OpenCode scoped source views |
| [0064](0064-opencode-projection-and-creation-origin.md) | OpenCode projection and creation Origin |
| [0065](0065-host-canonical-preparation.md) | Host Canonical publication preparation |
| [0066](0066-host-raw-preparation.md) | Host Raw preparation and receipt-aware reuse |
| [0067](0067-collector-capture-bootstrap.md) | Collector installation binding and capture journal bootstrap |
| [0068](0068-source-capture-runtime.md) | Explicit source capture runtime capability |
| [0069](0069-source-comparison-before-capture.md) | Read-only source comparison before durable capture |
| [0070](0070-source-collector-recovery-and-scheduling.md) | Source Collector recovery and scheduling |
| [0071](0071-bounded-raw-manifest-browsing.md) | Bounded Raw manifest browsing |
| [0072](0072-localization-boundary.md) | Localization boundary for Web and CLI |
| [0073](0073-capture-journal-metadata-admission.md) | Capture journal metadata admission |
| [0074](0074-capture-observation-retention.md) | Retire superseded capture record membership |
| [0075](0075-confirmed-collector-progress.md) | Confirmed Canonical progress in Collector checkpoints |
| [0076](0076-source-collection-release-admission.md) | Source collection admission for the first OpenCode release |
| [0077](0077-opencode-local-first-publication.md) | Local first publication of OpenCode 0.5.0 |
| [0078](0078-cli-adapter-maintenance-and-inspection.md) | Isolated Adapter maintenance and bounded CLI inspection |
| [0079](0079-cli-module-boundaries.md) | Collector and CLI Module boundaries |
| [0080](0080-cli-input-and-adapter-slot-lifetime.md) | CLI input and Adapter slot lifetime |

When adding a decision, choose an unused number and add it here. Preserve an old
record's rationale when a later decision changes it; link the amendment or
replacement in both directions where applicable. Do not rewrite historical
release authorization or evidence as if it applied to a new candidate.
