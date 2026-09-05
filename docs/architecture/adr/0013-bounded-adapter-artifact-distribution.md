# ADR-0013: Bounded Adapter Artifact Distribution

- Status: Accepted
- Date: 2026-09-05

## Context

ADR-0012 keeps Harness Adapters outside the base CLI, but source-directory installation is not a usable release boundary. A teammate needs to install a ready-built Adapter from the same release as the CLI, while ATape must not execute package lifecycle code merely to discover an Adapter's identity. GitHub Release assets are also useful before the project chooses a public npm scope.

An Adapter is ultimately trusted executable code. The installation path can still be inert and resource-bounded so malformed or unexpectedly large archives do not consume unbounded memory or mutate the Adapter installation before their contract is known.

## Decision

ATape accepts four Adapter package sources: npm registry specifiers, local package directories, local npm `.tgz`/`.tar.gz` archives, and HTTPS archive URLs.

- Local and downloaded archives use npm's `package/package.json` layout. The Node AdapterPackages Implementation streams gzip and TAR data, validates TAR header checksums, and reads only a regular `package/package.json` entry.
- Archive handling is capped at 32 MiB compressed, 64 MiB of expanded scan data, and 256 KiB for `package.json`. It does not buffer or extract the complete expanded archive.
- HTTPS sources cannot embed credentials, must name a `.tgz` or `.tar.gz` asset, have a 30-second request deadline, remain HTTPS after redirects, and are written into an owner-private staging directory. Release runs on success and failure remove that directory.
- Local and remote manifests are decoded before npm installation. Registry package manifests are decoded immediately after installation because their bytes are not locally available beforehand. Every npm install uses `--ignore-scripts`, and every installed entry is checked to remain inside the package and name a regular file before runtime import.
- Registry upgrades request `latest`. Local sources retain their canonical `file:` path. HTTPS sources retain and fetch the same URL, so an immutable versioned URL does not silently change versions.
- The first-party Codex Adapter is one Node 24 ESM bundle with no runtime package dependency. A release contains separate CLI and Codex Adapter npm tarballs plus `SHA256SUMS`.
- Release verification installs the CLI in a clean npm prefix, uses that binary to install the packaged Codex Adapter, and executes an empty bounded collection cycle without resolving code from the monorepo.

## Consequences

- The base CLI remains small and Harness-neutral while first-party and third-party Adapters can ship independently.
- Installation performs no package-provided code, but users must still trust an Adapter before enabling it because collection executes its entry in the Collector process.
- Size limits intentionally reject unusually large Adapter archives; such an Adapter must reduce its distribution or motivate a later protocol change.
- SHA-256 checksums detect accidental corruption and support externally authenticated release metadata. They are not a signature or a substitute for a trusted download channel.
- HTTPS upgrade behavior is deterministic but does not discover a newer immutable GitHub Release asset automatically.

## Rejected Alternatives

- **Bundle Codex into the CLI**: couples Harness release cadence and grows every CLI installation.
- **Extract archives before inspection**: expands the path traversal and disk-write surface without helping npm installation.
- **Run npm lifecycle scripts**: permits package code execution before ATape has accepted the Adapter contract.
- **Read the whole archive into memory**: makes malformed or large packages capable of exhausting the CLI process.
