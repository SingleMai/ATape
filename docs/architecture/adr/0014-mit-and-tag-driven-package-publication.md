# ADR-0014: MIT and Tag-Driven Package Publication

- Status: Accepted
- Date: 2026-09-05

## Context

ADR-0012 deliberately blocked registry publication until ATape selected a license and secured its npm namespace. The project owner has selected the MIT License and acquired the `@atape` npm scope. The release process now needs to publish the independently bundled CLI and Codex Adapter without creating a second build path or relying indefinitely on a long-lived registry token.

Publishing two immutable npm versions and one GitHub Release cannot be one atomic transaction. The workflow must therefore prevent version drift before publication and make a partially completed release safely recoverable.

## Decision

- The repository, `@atape/cli`, and `@atape/adapter-codex` use the MIT License with copyright attributed to ATape contributors.
- The workspace root remains private. The two leaf packages are public, target only `https://registry.npmjs.org/`, and retain repository metadata matching `SingleMai/ATape` for npm provenance.
- All three manifests share one SemVer version. A release tag is exactly `v<version>`.
- A push of that tag to the canonical repository runs `.github/workflows/release.yml` on a GitHub-hosted runner. The job installs pinned workspace dependencies, runs all checks and production builds, and verifies the clean release boundary before publication.
- npm receives the exact `.tgz` bytes already covered by `SHA256SUMS` and exercised by release verification. The workflow does not rebuild a package inside `npm publish`.
- Publication uses npm Trusted Publishing through GitHub OIDC after bootstrap and requests provenance. Because npm requires a package to exist before a Trusted Publisher can be configured, the first publication may use a short-lived granular `NPM_TOKEN`; it is removed after both package trust relationships work.
- On retry, an existing package version is skipped only if its npm SHA-512 integrity equals the local release artifact. Any mismatch is a terminal release failure. The GitHub Release is created after both npm packages are confirmed.

## Consequences

- Consumers can install the CLI and Codex Adapter by stable `@atape` names or use checksummed GitHub Release tarballs.
- MIT permits broad reuse with attribution and warranty disclaimer while keeping the open-source contribution boundary simple.
- A compromised long-lived publish token is not part of steady-state release operation. Tag protection, GitHub environment approvals, or npm staged publication can add stronger human gates later without changing package artifacts.
- First publication has an explicit one-time credential bootstrap because OIDC trust cannot target nonexistent npm packages.
- A release can be partially visible on npm before its GitHub Release exists, but deterministic integrity checks make the same workflow safely resumable.

## Rejected Alternatives

- **Keep tarball-only distribution**: makes installation and unified upgrades unnecessarily manual after the public namespace is available.
- **Publish from package source directories**: can rebuild different bytes than the verified release artifacts.
- **Permanent npm automation token**: creates a broad, rotatable secret where short-lived OIDC credentials are supported.
- **Independent CLI and Adapter versions in v0.1**: adds coordination and tag complexity before separate release cadence creates meaningful value.
