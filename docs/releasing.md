# Releasing ATape

ATape's release pipeline builds eight MIT-licensed npm packages with public publication metadata in one versioned release:

- `@atape/cli`
- `@atape/adapter-codex`
- `@atape/adapter-claude`
- `@atape/adapter-opencode`
- `@atape/adapter-codebuddy`
- `@atape/adapter-kimi`
- `@atape/adapter-grok`
- `@atape/adapter-cursor`

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

The Server toolchain is pinned to Go `1.26.9` in `server/go.mod`, the reachable
dependency scan and the Server image builder. CI and release workflows read the
module version. Keep these pins aligned on a supported Go branch when applying
security updates; the [Go release policy and history](https://go.dev/doc/devel/release)
record branch support and patch fixes. Go `1.26.9` includes the October 8, 2026
standard-library security fixes. Historical candidate evidence retains the
toolchain actually tested.

Server and Web runtime Dockerfiles upgrade Alpine packages before adding their
runtime dependencies. Security scans the resulting images; candidate evidence
must identify the immutable images actually tested.

`test:release` checks the four-file, self-contained Adapter packages, builds all
eight checksummed tarballs and installs the CLI into a clean prefix. It installs
a disposable integration and verifies the installed console/daemon through a PTY.
Release Adapter checks install Codex, Claude, OpenCode, CodeBuddy, Kimi, Grok and Cursor through the source Node
Host’s application Interface. The Claude package replacement check replaces a
test-only pre-release Claude package with the exact release tarball via
the original-source update Module Interface, checking byte-identical generated
checkpoint state, unchanged Project/tool selections and the installed v2 runtime.
The test-only package
uses the current bundle with a distinct version; it is not historical compatibility
evidence and never enters `release/`. Claude delivery, migration, append, rewind,
compaction and recovery require both the current sourceCapture and genuine
previous-main legacy contracts over authenticated HTTP/PostgreSQL; missing or
skipped subtests fail the gate. Real Go persistence/read behavior remains
covered by the CLI/Go end-to-end suite, including actual OpenCode, CodeBuddy, Kimi and Grok package replacement,
independent Canonical/Raw progress, no-op recovery and background source changes.
Cursor's separate installed contract exercises controlled start, synthetic native
facts, confirmed creation receipts, nullable Reader/Search times, upload-time
redaction and frozen recovery through authenticated HTTP/PostgreSQL. It does not
establish authenticated native Cursor acceptance.
For 0.5.9 on POSIX, the exact tarball release verifier additionally requires the
[stopped Claude v4 transition](cli/setup-and-adapters.md#claude-v4-058-to-059).
It downloads the immutable npm-published CLI/Claude 0.5.8 archives anonymously,
with fixed SHA-512 integrity, an 8 MiB bound and a 30-second deadline for each.
Unavailable, altered or oversized historical bytes fail this automated gate;
there is no optional skip. Each run owns a fresh temporary HOME, npm cache and
installation prefix, and cleans them after joining its CLI/Collector processes.
The test executes genuine old automatic/UI refusal, external real npm entry
refresh, actual new console complete-bundle selection and old reader-floor
refusal. Catalog and Server HTTP are external Test Adapters; Provider live
capture and OS registration are outside this gate. Other versions and Windows
retain their existing verification paths. To rerun this exact gate against an
already frozen artifact directory without building or repacking:

```sh
node apps/cli/scripts/tool-identity-release-gate.mjs /absolute/frozen/tarballs
```

For 0.5.10 and later on POSIX, the exact verifier also requires the
[stopped Codex clock transition](cli/setup-and-adapters.md#codex-source-clocks-059-to-0510).
The separate clock gate anonymously downloads the genuine npm-published CLI and
Codex 0.5.9 archives with fixed SHA-512 integrity, the same 8 MiB bound and
30-second deadline. It captures controlled native-format records and Raw through
the old installed Collector, verifies automatic and interactive refusal before
pause, then executes the actual stopped console's complete-bundle update.
The installed target must preserve checkpoint/credential bytes and Stop intent,
replay available history under nullable v3 with stable IDs and higher revisions,
retain Raw receipts, and continue through no-op and append. The genuine old
Adapter must refuse the resulting projection-v5 cursor. Distribution and Server
HTTP are external Test Adapters; this does not establish live Provider or
production acceptance. Windows has no POSIX PTY contract here. There is no
environment override that skips the required POSIX gate. To verify an already
frozen checksummed directory without building or repacking:

```sh
node apps/cli/scripts/codex-clock-release-gate.mjs /absolute/frozen/tarballs
```

The exact checksummed OpenCode, CodeBuddy, Kimi, Grok and Cursor artifacts also run their installed source-capability
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

npm Trusted Publishing can only be configured after a package already exists.
For a newly introduced package that does not yet exist in npm, bootstrap its
first publication before configuring trust. Existing packages continue through
their configured OIDC route; a new version does not require repeating package
bootstrap or account authorization. Cursor's one-version 0.5.6 exception is
recorded in [ADR-0117](architecture/adr/0117-cursor-local-first-publication.md).
The ordinary new-package bootstrap procedure is:

1. Enable two-factor authentication on the npm owner account.
2. Create a short-lived granular access token (GAT) scoped to the `@atape` packages being bootstrapped and with bypass-2FA enabled.
3. Add it to the GitHub repository as the `NPM_TOKEN` Actions secret. Only the publication step receives it as `NODE_AUTH_TOKEN`; ordinary CI and verification steps do not receive it. When the secret is absent, existing packages use their configured OIDC Trusted Publisher. A new package needs the bootstrap token before tagging.
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
for that one package version. All automated gates remain required. For that release, the ordinary
tag workflow covered the other three packages and verified the already-published
OpenCode bytes before creating the GitHub Release.

For `@atape/adapter-cursor@0.5.6` only,
[ADR-0117](architecture/adr/0117-cursor-local-first-publication.md) selects local
account/MFA bootstrap with the exact verified tarball, followed by ordinary
workflow publication of the other seven packages. It records the artifact digest
and missing GitHub provenance for that one package version. All automated gates
remain required, and the workflow accepts the existing version only when its
integrity matches.

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
npm trust github @atape/adapter-codebuddy --file release.yml --repo SingleMai/ATape --allow-publish
npm trust github @atape/adapter-kimi --file release.yml --repo SingleMai/ATape --allow-publish
npm trust github @atape/adapter-grok --file release.yml --repo SingleMai/ATape --allow-publish
npm trust github @atape/adapter-cursor --file release.yml --repo SingleMai/ATape --allow-publish
```

Run one release through OIDC, then delete the `NPM_TOKEN` repository secret and configure npm publishing access to disallow traditional tokens. GitHub-hosted runners receive short-lived credentials through the workflow's `id-token: write` permission. Public repositories and packages also receive npm provenance attestations.

A new trust configuration must complete its first successful OIDC publish within
two days or be recreated. A same-version retry that skips an already published
package does not validate that package's trust configuration. Configure near the
next real publication; do not manufacture a placeholder version to exercise it.
See [npm's configuration expiry](https://docs.npmjs.com/trusted-publishers/#trusted-publisher-configuration-expiry).

## Publication order and recovery

Publication workflows serialize in the fixed `atape-release-publication` queue
without canceling an active run. One publication Module owns ordering: seven
Adapters first, CLI last, then the versioned GitHub Release, the
persistent compatible catalogs and the static CDN snapshot. It publishes private copies of the exact verified
local tarball bytes. Both publication entry points validate the exact filename
set, package identities, byte digests and SHA256SUMS before any external write.
Reruns skip an existing npm version only when its integrity
matches. A definite immutable-version conflict during npm propagation proceeds to
the same public visibility check; authentication and other failures stop the run.

Before any version is advertised, anonymously retrieve all eight exact public npm
manifests **and their tarball bytes**. Check identities, canonical URLs and SHA-512
against the local artifacts within one ten-minute propagation budget. Each artifact
is limited to 16 MiB, matching client acquisition. An incomplete or mismatched
publication does not change the catalog. Existing versioned Release assets are
also compared byte for byte before completing a draft or updating its descriptor.
JSON-encoded descriptor and catalog bodies are limited to 128 KiB before the
first npm write, leaving room for GitHub metadata within the client budget.
`publication.json` retains the workflow's publication result.

The real capture-v2 bridge's versioned stable Release retains its delimited
`atape.release-bundle.v1` descriptor and adds an independent
`atape.migration-release-bundle.v1` section containing strict bundle v2. Both must
agree on the package set and runtime identity. The fixed prerelease `atape-update-catalog-v1` contains
`atape.update-catalog.v1` JSON with monotonic revision and the latest complete
bundle by capture/control pair. It does not become GitHub Latest and its tag is
never moved. Same-version descriptor changes, catalog regression and removed
families fail. Publication updates the catalog last; an older queued run cannot
move an existing target backward.

The fixed prerelease `atape-update-catalog-v2` contains strict migration bundles
and routes keyed by source contract, control protocol and migration protocol/ID.
Finalize the version Release, advertise the v1 bridge, then advertise v2 routes.
An interrupted run can resume the missing advertisement. Old plan routes cannot
be removed or regressed; unreferenced superseded bundles can leave the bounded
catalog while immutable version descriptors and client receipts remain. Neither
catalog becomes GitHub Latest or moves its tag. Validate existing version
descriptors before npm writes, including versions no longer referenced by a catalog.

The v1 reader requires the original seven packages and accepts up to 32 unique
`@atape/*` entries. This allows additive official Adapters without changing the
reader protocol. All entries participate in immutable byte identity; unknown
Adapters are not automatically installed. The current publisher still verifies
exactly the eight packages built by this repository.

The publisher admits only the implemented capture-v2/control-v1
`journal-v7-to-v8` plan and validates its actual packed capabilities. Compatible
packages use explicit npm `latest`; a historical rerun behind the
public CLI target uses `atape-managed` and does not become GitHub Latest. This
uses the existing Trusted Publisher `npm publish` permission, without requiring a
separate `npm dist-tag` management grant. Capable clients discover the complete
catalog instead of individual tags; immutable historical clients retain their
old behavior. Keep a genuine catalog-capable v2 bridge at legacy GitHub/npm Latest
indefinitely. Future different-contract targets require nonlatest npm/GitHub
publication and a separately implemented, verified migration plan; the current
publisher rejects those unsupported plans before npm writes. See
[ADR-0108](architecture/adr/0108-compatible-release-bundle-discovery.md) and
[ADR-0115](architecture/adr/0115-explicit-capture-migrations.md).

Before releasing changes to configuration, checkpoints, journals or the managed
installation descriptor, establish the reader compatibility boundary. A rollback
path requires evidence that the retained runtime can read the resulting state;
unified package versions alone do not establish that compatibility. A migration
path instead requires a verified compiled plan, writer fence and forward recovery
through a durable completion receipt before unattended advertisement. Keep
candidate evidence specific to the checks actually run; creating the GitHub Release does not deploy the Server or
migrate an Instance. [ADR-0100](architecture/adr/0100-managed-automatic-updates.md)
records the selected update Interface and recovery obligations.

The CLI package declares its managed-runtime compatibility in `atapeRuntime`:
`protocol: "atape.runtime.v1"` and
`stateContract: "atape.client.v3-capture.v2"`,
`updateControlProtocol: "atape.update-control.v1"`,
`releaseCatalogProtocol: "atape.update-catalog.v1"`,
`migrationReleaseCatalogProtocol: "atape.update-catalog.v2"`,
`captureMigrationProtocol: "atape.capture-migration.v1"`, and the exact
`captureMigration` plan/from-contract declaration. Publication checks the actual
CLI archive; clients validate these capabilities and the installed executable
version before activation. Do not retain
the marker across an incompatible state-format change merely to make unattended
installation pass; design and verify migration/recovery first.

The v4 tool-identity release keeps the actual v8 journal and capture-v2 contract
only after genuine 0.5.8 SourceCollector recovery of the new compatible metadata
envelope is verified. This does not prove the old updater can decode a v4
candidate Adapter manifest. Active official-Claude 0.5.8 installations require
the stopped external CLI refresh and new-console complete-bundle action recorded
in [v0.5.9](releases/v0.5.9.md#upgrade-and-recovery-boundaries). Do not describe
that boundary as universal unattended delivery; source-free frozen recovery,
candidate acquisition and interactive delivery are distinct checks.

0.5.4 is the first v2 release. The published 0.5.3 updater must reject it before
candidate execution or maintenance; release evidence must not describe this as
a successful unattended upgrade. Its explicit stopped manual transition and
forward journal recovery are defined in
[ADR-0104](architecture/adr/0104-capture-v2-state-upgrade.md). Verify the old reader
with genuine historical source or published bytes, and verify missing Server
v2 capabilities leave the source's journal and legacy checkpoint unchanged.

## Static update distribution

The owned discovery origin is `https://updates.atape.net`. Cloudflare Workers
Static Assets serves strict catalog JSON at `/catalog/v1.json` and
`/catalog/v2.json`, with immutable descriptors at
`/releases/<version>/bundle.v1.json` and `bundle.v2.json`. This is a static
deployment without a dynamic proxy or client authentication. npm continues to
serve the actual package archives. Existing published clients retain GitHub's
catalog bridge; merging or deploying these files does not change their binaries.

[The static exporter](../scripts/export-static-update-catalog.mjs) validates
the current GitHub catalogs, version descriptors, release assets and public npm
identities/bytes before writing a complete snapshot. It also reads the current
static inventory, preserves historical exact descriptors and rejects catalog
regression, removed routes or rewritten immutable versions. Historical valid
seven-package bundles remain valid. `manifest.json` binds the complete file
inventory with SHA-256; it is publisher state, not a new client protocol or a
signature. A missing inventory on an established site is an error.

Cloudflare deployment uses [the dedicated Wrangler configuration](../wrangler-updates.jsonc)
and one complete export directory. Catalogs and inventory require revalidation;
version descriptors have a one-year immutable cache policy. Missing objects
return 404 rather than HTML fallback. After deployment, public verification
must check the complete advertised inventory and exact file hashes. Save that
result separately from the npm publication receipt.

The tag publication workflow exports and deploys only after the existing package
and GitHub publication steps succeed. The main-only
[Publish update metadata workflow](../.github/workflows/update-metadata.yml) can
re-export the actual public catalogs without publishing npm. Both writers share
`atape-release-publication` serialization and compare with the current snapshot;
rerunning an old workflow cannot intentionally restore an older advertisement.
Use the metadata-only workflow to recover an interrupted static deployment.
Do not roll back immutable descriptors or remove retained routes to repair it.

```sh
gh workflow run update-metadata.yml --ref main
```

Set the repository's `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` secrets
for this dedicated Worker. The configured account-owned token has Individual
Workers Editor permission restricted to `atape-updates`, without zone or DNS
permission. Initial domain setup is separate and uses the relevant zone lookup
access; ordinary asset publication does not bind or modify routes.
Never put a token in a catalog, repository file, CLI installation or workflow
log. Verify hostname ownership and existing routing before first binding a
custom domain. Do not overwrite the Server's existing Tunnel or DNS. Initial
bootstrap is explicit and must distinguish actual absent metadata from network
failure; a timeout or TLS failure cannot authorize a new empty snapshot.

This static deployment is independently authorized from package publication.
It does not deploy the Server, migrate a database, complete manual staging
acceptance or deliver a new CLI to installed users. See
[ADR-0119](architecture/adr/0119-static-update-distribution.md).
