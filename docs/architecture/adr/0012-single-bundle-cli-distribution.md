# ADR-0012: Single-Bundle CLI Distribution

- Status: Accepted
- Date: 2026-09-05

## Context

ATape's CLI currently runs TypeScript directly from the monorepo and imports private workspace packages. That is useful for development but does not produce an artifact a teammate can install independently. Distribution must preserve the existing Adapter-first runtime: adding Harness support must not expand or republish the base CLI, and a packaged background Collector must be able to restart the same installed executable after its launching terminal closes.

At the time of this decision, the project had not selected a source license or confirmed an npm registry scope. Packaging therefore had to remain verifiable without silently making either legal or registry decisions. Those temporary publication constraints were later resolved by [ADR-0014](0014-mit-and-tag-driven-package-publication.md).

## Considered Designs

### Publish every internal TypeScript package

Publishing `@atape/domain`, `@atape/application`, and `@atape/cli` separately preserves source-level package boundaries. It also turns private implementation boundaries into public versioning contracts and requires coordinated releases even though users only invoke one command.

### Ship TypeScript source and workspace dependencies

Node 24 can execute erasable TypeScript syntax, but npm consumers cannot resolve `workspace:*` dependencies and would receive repository layout as part of the runtime contract. This exposes implementation details without creating useful extension points.

### Bundle the CLI and keep Adapters external

One ESM executable can contain the CLI presentation, Effect application Modules, domain Schemas, and Node Layers. Harness Adapters remain independently installed packages and continue to load dynamically through the versioned Adapter Interface.

## Decision

ATape v0.1 packages `@atape/cli` as one npm-compatible tarball containing `dist/atape.js`, its package manifest, and CLI documentation.

- esbuild bundles the private TypeScript dependency graph into one readable Node 24 ESM executable and preserves the source shebang.
- `@atape/cli` exposes only the `atape` bin. Internal workspace packages are Implementation and are not published as runtime dependencies.
- Adapter package paths and dynamic imports remain runtime operations. Adapters are not bundled, and the existing manifest/protocol validation remains the extension Seam.
- The installed executable path becomes the managed Collector child entry, so `atape start` does not depend on a source checkout.
- A release verification script packs the exact npm artifact, installs it into a clean prefix, checks its file allowlist and size bound, installs a temporary Adapter, configures a Project, starts the installed Collector, observes a healthy cycle, and stops it.
- The package initially remained marked private until the repository owner selected a source license and confirmed the public registry name or scope. [ADR-0014](0014-mit-and-tag-driven-package-publication.md) removes that temporary guard.

## Consequences

- Users install one artifact and do not inherit ATape's monorepo structure.
- Private Module refactors do not require separate package compatibility releases.
- The CLI bundle is larger than a thin multi-package launcher, but remains below the explicit one-megabyte tarball gate before independently installed Adapters.
- Node 24 remains required because v0.1 Adapters may contain ready-to-run erasable TypeScript.
- npm publication was initially blocked pending the explicit license and registry decision; [ADR-0014](0014-mit-and-tag-driven-package-publication.md) defines the subsequent public release workflow.

## Rejected Alternatives

- **Publish internal packages**: creates shallow public contracts and coordinated release overhead.
- **Bundle Harness Adapters**: breaks Adapter-first release independence and increases every installation.
- **Native executable now**: embedding a JavaScript runtime complicates dynamic npm Adapter loading without improving the current product loop.
