# Releasing ATape

ATape's release pipeline includes four public MIT-licensed npm packages in one versioned release:

- `@atape/cli`
- `@atape/adapter-codex`
- `@atape/adapter-claude`
- `@atape/adapter-opencode`

The root, all public package manifests, private Web artifact, Server metadata,
container labels, and Compose build contract carry the same explicit SemVer and
Authentication epoch. A tag must be exactly `v<version>`; the release workflow
refuses version/epoch drift or an incomplete staging attestation.

## Local release verification

For v0.2.0 only, the user authorized a
[candidate-bound manual staging waiver](architecture/adr/0034-v0.2.0-manual-release-waiver.md).
The staging attestation stays pending; the separate waiver and release notes
disclose the missing evidence. This does not exempt any automated check and does
not authorize future releases or code changes after the recorded candidate.

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

`test:release` checks the four-file, self-contained Adapter packages, builds all
four checksummed tarballs and installs the CLI into a clean prefix. It installs
Codex, Claude and OpenCode through that CLI, then collects a controlled native Claude
fixture through an authenticated loopback HTTP test Adapter. It replaces a
test-only pre-release Claude package with the exact release tarball via
`adapters upgrade claude`, checking unchanged checkpoints, no duplicate upload,
stable Event identities and successful capture after append. The test-only package
uses the current bundle with a distinct version; it is not historical compatibility
evidence and never enters `release/`. Real Go persistence/read behavior remains
covered by the CLI/Go end-to-end suite, including actual OpenCode package replacement,
independent Canonical/Raw progress, no-op recovery and background source changes.
The exact checksummed OpenCode artifact also runs its installed source-capability
verification outside the checkout with controlled native data. The workflow publishes the exact release
tarballs and attaches them plus `SHA256SUMS` to the GitHub Release.

Pull requests and pushes to `main` run the same repository checks, production build, release-tarball verification, and PostgreSQL integration suite in an unprivileged CI workflow. That workflow has read-only repository permissions and no npm publication credentials.

For v0.2.0, follow the [auth-v1 release checklist](operations/auth-v1-release-checklist.md).

The dogfood Web has a separate [continuous deployment workflow](operations/aws-dogfood.md#automatic-web-deployment):
the latest `main` commit deploys after CI and Security both pass. This does not
publish npm packages or deploy the Server, and does not complete the versioned
release attestation.
The checked-in staging attestation intentionally starts as `pending`; this lets
CI validate the evidence shape without pretending that the official GitHub,
TLS/WAF, backup, smoke, and rollback exercises happened. After those exercises,
the final evidence-only commit completes the attestation. Release mode verifies
that the tested commit is an ancestor and that no file except that attestation
changed afterward.

## First publication bootstrap

npm Trusted Publishing can only be configured after a package already exists. For each package's first release (including the new OpenCode Adapter):

1. Enable two-factor authentication on the npm owner account.
2. Create a granular access token (GAT) with a one-day expiry, package publish permission and bypass-2FA enabled. Select only the package being bootstrapped, or the `@atape` scope when the new package cannot yet be selected. Grant no organization-management permission.
3. Add it to the GitHub repository as the `NPM_TOKEN` Actions secret. Only the publication step receives it as `NODE_AUTH_TOKEN`; checks and builds do not. Without the secret, the same step uses npm Trusted Publishing.
4. Push the matching release tag, for example `v0.1.0`.

```sh
git tag v0.1.0
git push origin v0.1.0
```

The workflow runs all checks before making external changes. npm publication is recoverable: when a version already exists, the workflow verifies its SHA-512 registry integrity against the local release tarball and skips it only when the bytes match.

## Switch to npm Trusted Publishing

After the packages exist, configure a GitHub Actions Trusted Publisher for each package with these exact values:

- Repository: `SingleMai/ATape`
- Workflow filename: `release.yml`
- Permission: allow `npm publish`

This can be done in each package's npm settings, or with npm CLI 11.15 or newer while signed in with 2FA:

```sh
npm trust github @atape/cli --file release.yml --repo SingleMai/ATape --allow-publish
npm trust github @atape/adapter-codex --file release.yml --repo SingleMai/ATape --allow-publish
npm trust github @atape/adapter-claude --file release.yml --repo SingleMai/ATape --allow-publish
npm trust github @atape/adapter-opencode --file release.yml --repo SingleMai/ATape --allow-publish
```

After the first publication, configure the new package's trust relationship, revoke the bootstrap GAT and delete the `NPM_TOKEN` repository secret. Configure npm publishing access to disallow traditional tokens. The next version uses only OIDC; verify its successful publication and provenance without creating a placeholder version just to test trust. GitHub-hosted runners receive short-lived credentials through the workflow's `id-token: write` permission. Public repositories and packages also receive npm provenance attestations.

## Publication order and recovery

The workflow publishes the CLI and all three Adapters sequentially, then creates the GitHub Release. If a later step fails, rerunning the same workflow is safe only when already-published npm integrity matches the locally rebuilt tarball. A mismatch stops publication and requires investigation; npm versions are immutable and must never be overwritten.
