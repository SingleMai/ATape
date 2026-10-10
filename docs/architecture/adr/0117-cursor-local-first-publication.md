# ADR-0117: Local first publication of Cursor 0.5.6

- Status: Accepted for the authorized 0.5.6 publication
- Date: 2026-10-10

## Context and authorization

The user authorized npm publication with “npm 可以发布 然后我要做下授权。。”
and completed the npm web login. The new `@atape/adapter-cursor` package does
not yet exist in the public registry, so its Trusted Publisher cannot be
configured before bootstrap. The other seven packages already use the existing
GitHub Actions publication route without a repository npm token.

Use the interactive local account for this one bootstrap rather than introducing
a temporary write token into GitHub. This is an implementation choice within the
authorized publication, not a claim that the user explicitly selected a token
mechanism. The manual staging waiver remains separately bound under ADR-0048.

## Decision

For `@atape/adapter-cursor@0.5.6` only, publish the exact verified
`atape-adapter-cursor-0.5.6.tgz` using the authenticated local npm account and
account MFA. Its SHA-256 is
`277f545cdc53263d3d14c8ea47903e0bfb32872842af96bd387590f8a18c6225`.
All candidate CI, installed integration and security gates must pass first.
Check the package identity and SHA256SUMS immediately before the write, then
anonymously retrieve the public manifest and tarball and compare exact bytes and
SHA-512 with the tested artifact.

This is a one-version exception to
[ADR-0014](0014-mit-and-tag-driven-package-publication.md). Local publication
does not carry a GitHub build provenance attestation; the release notes disclose
that limitation. Do not impersonate a CI environment, weaken the production
publisher restriction, copy credentials into GitHub, or request secrets in chat.
[ADR-0077](0077-opencode-local-first-publication.md) is a historical precedent,
not authorization for this package.

After the reviewed candidate is merged, the matching immutable release tag runs
the ordinary workflow for the other seven packages. It skips Cursor only if the
registry integrity matches its own rebuilt tarball. Complete public verification
of all eight artifacts precedes the GitHub Release and compatible catalog update.
Do not move the tag, overwrite an npm version or advertise a partial bundle.

Configure Cursor's Trusted Publisher for repository `SingleMai/ATape`, workflow
`release.yml`, with direct `npm publish` permission. Later real versions return
to the ordinary OIDC route. Configuration is not evidence of successful OIDC
publication: the current workflow skips the locally published version. npm
[requires a new trust configuration to publish within two days](https://docs.npmjs.com/trusted-publishers/#trusted-publisher-configuration-expiry);
if the next real release is later, recreate an expired configuration then.
Do not manufacture a placeholder release to validate trust.

This decision authorizes no Server deployment or production database migration.
