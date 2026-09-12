# Releasing ATape

ATape's release pipeline includes four public MIT-licensed npm packages in one versioned release:

- `@atape/cli`
- `@atape/adapter-codex`
- `@atape/adapter-claude`
- `@atape/adapter-opencode`

The root, all public package manifests, private Web artifact, Server metadata,
container labels, and Compose build contract carry the same explicit SemVer and
Authentication epoch. A tag must be exactly `v<version>`; the release workflow
refuses version/epoch drift and requires either completed staging evidence or
an authorized candidate-bound manual waiver.

## Authorization and evidence

An explicit package publication request also authorizes waiving incomplete
manual staging acceptance for that requested release under
[ADR-0048](architecture/adr/0048-release-request-manual-acceptance.md).
Do not ask for a second per-version waiver confirmation. Coding or merge requests
alone do not authorize publication; publication does not authorize Server
deployment or database migration. Automated CI, integration and security gates
remain required in either evidence path.

Use [the release contract](../specs/auth-v1-release.json) and
[gate index](../specs/auth-v1-release-gates.json) for the candidate version,
Authentication epoch, minimum CLI version, evidence path and manual requirements.
Never copy a historical version's acceptance result into a new candidate.

- **Completed acceptance:** complete the staging attestation with actual evidence
  for every required check. Record the tested commit and immutable image digests.
  Only that attestation may change after the tested candidate.
- **Manual waiver:** leave staging `pending`, record the publication request,
  authorization date, exact candidate and all unverified checks in
  `docs/releases/evidence/v<version>-manual-waiver.json`, and disclose them in
  `docs/releases/v<version>.md`. Prepare the release notes before freezing the
  candidate; only the waiver file may change after it.

The [gate verifier](../scripts/verify-auth-release-gates.mjs) and
[waiver verifier](../scripts/manual-release-waiver.mjs) enforce these evidence
boundaries. A candidate change requires fresh applicable evidence, not an edit
that makes old test results appear to cover new code. Historical per-version
waiver ADRs remain records of their original authorization.

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
ATAPE_RELEASE_TAG="v$(node -p 'require("./package.json").version')"
node scripts/check-release-tag.mjs "$ATAPE_RELEASE_TAG"
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

The [auth-v1 release checklist](operations/auth-v1-release-checklist.md) describes
the manual scenarios. Its v0.2.0 identities are historical; use the current
release contract and evidence paths for a new candidate.

The dogfood Web has a separate [continuous deployment workflow](operations/aws-dogfood.md#automatic-web-deployment):
the latest `main` commit deploys after CI and Security both pass. This does not
publish npm packages or deploy the Server, and does not complete the versioned
release attestation.
The checked-in staging attestation intentionally starts as `pending`; CI mode
validates the evidence shape without claiming that official GitHub, TLS/WAF,
backup, smoke or rollback exercises happened. Release mode validates one of the
two candidate-bound evidence paths above. Neither mode runs all the automated
gates merely by checking the index.

## First publication bootstrap

npm Trusted Publishing can only be configured after a package already exists. For each package's first release (including the new OpenCode Adapter):

1. Enable two-factor authentication on the npm owner account.
2. Create a short-lived granular access token (GAT) scoped to the `@atape` packages being bootstrapped and with bypass-2FA enabled.
3. Add it to the GitHub repository as the `NPM_TOKEN` Actions secret. This route requires explicitly wiring that secret into the publication step; the current workflow uses OIDC without a token fallback.
4. After the required checks and evidence pass, push the matching release tag.

```sh
ATAPE_RELEASE_TAG="v$(node -p 'require("./package.json").version')"
git tag "$ATAPE_RELEASE_TAG"
git push origin "$ATAPE_RELEASE_TAG"
```

The workflow runs all checks before making external changes. npm publication is recoverable: when a version already exists, the workflow verifies its SHA-512 registry integrity against the local release tarball and skips it only when the bytes match.

For `@atape/adapter-opencode@0.5.0` only, the user requested local first publication
with the already authenticated npm account, then later trusted-publisher setup.
[ADR-0077](architecture/adr/0077-opencode-local-first-publication.md) records this
exception, the exact artifact digest and the absence of GitHub build provenance
for that one package version. All automated gates remain required. The ordinary
tag workflow publishes the other three packages and verifies the already-published
OpenCode bytes before creating the GitHub Release.

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

Run one release through OIDC, then delete the `NPM_TOKEN` repository secret and configure npm publishing access to disallow traditional tokens. GitHub-hosted runners receive short-lived credentials through the workflow's `id-token: write` permission. Public repositories and packages also receive npm provenance attestations.

## Publication order and recovery

The workflow publishes the CLI and all three Adapters sequentially, then creates the GitHub Release. If a later step fails, rerunning the same workflow is safe only when already-published npm integrity matches the locally rebuilt tarball. A mismatch stops publication and requires investigation; npm versions are immutable and must never be overwritten.
