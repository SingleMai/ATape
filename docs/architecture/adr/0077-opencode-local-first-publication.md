# ADR-0077: Local first publication of OpenCode 0.5.0

- Status: Accepted by explicit user direction
- Date: 2026-09-11

## Context and authorization

npm requires a package to exist before its Trusted Publisher can be configured.
The authenticated trust request for the new OpenCode package returned E404.
After the proposed short-lived GitHub Actions token bootstrap, the user directed:
“你直接拿我本地发一起， 然后后面我就配成自动发布呗”.
This authorizes using the already authenticated local npm account for the new
package's first publication, with trusted-publisher configuration afterward.

## Decision

For `@atape/adapter-opencode@0.5.0` only, publish the exact locally verified
`atape-adapter-opencode-0.5.0.tgz` from the operator's machine. Its SHA-256 is
`1443463999a57ecdb27a9edbe9e02247252c97d3e1add7eb1b3219bad7a77216`.
All candidate CI, integration and security gates must pass before publication;
the existing manual-only staging waiver remains separate.

This is a one-version exception to ADR-0014's GitHub Actions publication route.
Local publication has no GitHub build provenance attestation. Disclose that
limitation in the release notes; do not fabricate a CI environment or change the
production publisher's GitHub Actions restriction. No npm credential is copied
into GitHub, committed, logged or requested in chat. Account MFA still applies.

After local publication, verify npm's SHA-512 integrity against the tested tarball.
Push the matching release tag only after the reviewed candidate is merged. The
existing release workflow publishes CLI, Codex and Claude with provenance, skips
OpenCode only when its registry integrity matches the rebuilt artifact, and
creates the GitHub Release with all four tarballs and checksums.

The user will configure the new package's Trusted Publisher for
`SingleMai/ATape`, workflow `release.yml`, allowing `npm publish`. Future versions
return to the ordinary OIDC release route. No placeholder version is published
to test that configuration, and no Server deployment or migration is authorized.
