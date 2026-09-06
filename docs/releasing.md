# Releasing ATape

ATape publishes two public MIT-licensed npm packages from one versioned release:

- `@atape/cli`
- `@atape/adapter-codex`

The root, both public package manifests, private Web artifact, Server metadata,
container labels, and Compose build contract carry the same explicit SemVer and
Authentication epoch. A tag must be exactly `v<version>`; the release workflow
refuses version/epoch drift or an incomplete staging attestation.

## Local release verification

Before creating a tag, run:

```sh
pnpm check
pnpm build
pnpm build:release:images candidate
pnpm test:release
pnpm test:go:integration
pnpm test:go:race
pnpm test:go:fuzz
pnpm test:security:dependencies
pnpm test:self-hosting:config
pnpm test:self-hosting:restore
pnpm test:release:gates
node scripts/check-release-tag.mjs v0.2.0
```

`test:release` builds checksummed npm tarballs, installs the CLI into a clean prefix, installs the packaged Codex Adapter through that CLI, and executes a bounded collection. The workflow publishes those exact tarballs to npm and attaches them plus `SHA256SUMS` to the GitHub Release.

Pull requests and pushes to `main` run the same repository checks, production build, release-tarball verification, and PostgreSQL integration suite in an unprivileged CI workflow. That workflow has read-only repository permissions and no npm publication credentials.

For v0.2.0, follow the [auth-v1 release checklist](operations/auth-v1-release-checklist.md).
The checked-in staging attestation intentionally starts as `pending`; this lets
CI validate the evidence shape without pretending that the official GitHub,
TLS/WAF, backup, smoke, and rollback exercises happened. After those exercises,
the final evidence-only commit completes the attestation. Release mode verifies
that the tested commit is an ancestor and that no file except that attestation
changed afterward.

## First publication bootstrap

npm Trusted Publishing can only be configured after a package already exists. For the first release of both packages:

1. Enable two-factor authentication on the npm owner account.
2. Create a short-lived granular access token (GAT) that can publish the two `@atape` packages and has bypass-2FA enabled.
3. Add it to the GitHub repository as the `NPM_TOKEN` Actions secret.
4. Push the matching release tag, for example `v0.1.0`.

```sh
git tag v0.1.0
git push origin v0.1.0
```

The workflow runs all checks before making external changes. npm publication is recoverable: when a version already exists, the workflow verifies its SHA-512 registry integrity against the local release tarball and skips it only when the bytes match.

## Switch to npm Trusted Publishing

After both packages exist, configure a GitHub Actions Trusted Publisher for each package with these exact values:

- Repository: `SingleMai/ATape`
- Workflow filename: `release.yml`
- Permission: allow `npm publish`

This can be done in each package's npm settings, or with npm CLI 11.15 or newer while signed in with 2FA:

```sh
npm trust github @atape/cli --file release.yml --repo SingleMai/ATape --allow-publish
npm trust github @atape/adapter-codex --file release.yml --repo SingleMai/ATape --allow-publish
```

Run one release through OIDC, then delete the `NPM_TOKEN` repository secret and configure npm publishing access to disallow traditional tokens. GitHub-hosted runners receive short-lived credentials through the workflow's `id-token: write` permission. Public repositories and packages also receive npm provenance attestations.

## Publication order and recovery

The workflow publishes the CLI and Adapter sequentially, then creates the GitHub Release. If a later step fails, rerunning the same workflow is safe only when already-published npm integrity matches the locally rebuilt tarball. A mismatch stops publication and requires investigation; npm versions are immutable and must never be overwritten.
