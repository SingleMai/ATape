# ADR-0008: Node CLI and On-Demand Adapter Packages

- Status: Accepted
- Date: 2026-09-04

## Context

ATape must let each member keep their preferred Harness CLI while explicitly selecting which local Git repositories or ordinary directories may be captured. The client needs one place to manage Project paths, Adapter installation, per-Project enablement, and upgrades. Local paths and Adapter parameters remain on the member's machine.

Adapters should be independently extensible without making the base CLI grow with every Harness. Disabled Adapters must not consume runtime memory, and installing many Adapters must not create many persistent sidecar processes. The client application also follows the repository-wide requirement that TypeScript uses Effect for I/O, typed failures, resource lifetime, and workflows.

## Considered Designs

### Bundle every Adapter into one CLI binary

Bundling makes startup and distribution straightforward, but every Adapter increases the base download and dependency graph. Adapter fixes require a complete CLI release, and provider-specific dependencies are loaded or at least installed for every member.

### Run every Adapter as a persistent sidecar

Independent processes provide strong dependency and crash isolation. They also add idle memory, process supervision, IPC versioning, and lifecycle complexity before ATape has evidence that individual Adapters need this isolation.

### Install packages independently and load only configured Adapters

A Node CLI manages Adapter packages in an isolated ATape data directory. Projects reference Adapter IDs. A future shared Adapter Host dynamically imports only the packages enabled for active Projects, calls a small versioned Interface, and releases them with the owning collection scope.

## Decision

ATape v0.1 uses a TypeScript/Node CLI powered by Effect and independently installed npm Adapter packages.

- `apps/cli` owns argument parsing, interactive prompts, and terminal rendering only.
- The client management Module owns setup, immutable Project identity, Adapter installation records, per-Project enablement, and unified upgrades.
- Node Layers own filesystem, Git discovery, and npm process execution. Expected failures remain typed until the CLI presentation edge.
- Client configuration is Effect-Schema decoded and stored atomically in the user's platform configuration directory. Files use owner-only permissions. `ATAPE_CONFIG_FILE` and `ATAPE_ADAPTER_DIRECTORY` are explicit deployment/test overrides.
- `atape setup` defaults to the current directory. In `auto` mode, a path inside a Git worktree resolves to the repository root and becomes a `git` Project. `--type directory` preserves the exact ordinary directory instead of promoting it to a Git repository.
- Local paths never enter Team, Project, Canonical, Raw, or Search server payloads. They exist only in client configuration.
- Project ID, Team, name, and type are immutable after local setup, matching server ingestion identity. Re-running the exact setup is idempotent; changing identity requires removing the local Project first and does not delete server history.
- Adapters install into one isolated npm prefix. Package lifecycle scripts are disabled; published Adapters must contain ready-to-run output.
- An Adapter package declares a versioned `atapeAdapter` manifest in `package.json`. Installation validates this manifest without importing or executing Adapter source.
- `atape adapters enable/disable` changes one Project's configured Adapter IDs. It does not start or stop a daemon.
- `atape adapters upgrade --all` upgrades installed packages sequentially. npm mutates one shared installation tree, so concurrent package-manager writes are intentionally avoided.
- Disabled or unrelated Adapters are not imported. There is no persistent process per Adapter.

The first slice implements the management plane. The following Collector Host slice will define the executable Adapter Interface, dynamically load only enabled packages, bound collection concurrency, redact secrets, and submit Canonical and Raw observations every 10–30 seconds.

## Consequences

- ATape can add Harness support without adding dependencies to the base CLI or server.
- Node is shared with the Web/Effect toolchain and makes JavaScript Adapter authoring approachable for an open-source ecosystem.
- A member needs a supported Node runtime for v0.1; a self-contained binary may be added later without changing client configuration or Adapter protocol semantics.
- Package installation may briefly spawn npm, but normal configuration and future collection do not keep one subprocess per Adapter.
- In-process Adapters share the Adapter Host's trust boundary. Installation is explicit, lifecycle scripts are disabled, and a future out-of-process isolation mode remains possible for untrusted Adapters.
- Atomic local configuration prevents a partial write from erasing the member's setup, while server-side captured history remains unaffected by local removal.

## Rejected Alternatives

- **Rust CLI first**: gives a compact native binary, but would duplicate the selected Effect client architecture and make JavaScript Adapter loading require an IPC/plugin ABI immediately.
- **Bundled Adapters**: couples Adapter release cadence, size, and dependencies to the base CLI.
- **Persistent sidecars by default**: pays supervision and memory costs before isolation requirements justify them.
- **Project-local configuration committed to Git**: risks leaking machine paths and personal capture choices to the repository.
