# auth-v1 release checklist

This is the human half of the v0.2.0 release gate. CI is necessary but cannot
prove the configured GitHub OAuth App, `atape.dev` edge, backups, or operator
rollback. Run this checklist against one immutable candidate commit and the two
images built from it. Never paste Cookie, OAuth code/state, bearer credential,
user code, Provider token, secret file content, or a user's local path into an
evidence artifact.

## 1. Freeze and verify the candidate

Record the full commit SHA and immutable Server/Web image digests. Confirm both
image labels report `0.2.0`, `auth-v1`, and minimum CLI `0.2.0`; confirm
`atape-server version --json` and `/api/v1/instance` report the same values.

Run and retain links to the CI and Security workflow runs for that commit:

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
```

## 2. TLS / callback / WAF

- TLS is valid for the exact public origin; the edge forwards only the intended
  Web/API routes and never PostgreSQL or a private Compose port.
- The GitHub callback exactly equals
  `https://atape.dev/api/v1/auth/github/callback` for the official same-origin
  topology. Host and forwarding headers cannot change it.
- Cookie scope, Secure/HttpOnly/SameSite attributes, exact Origin/CORS/CSRF,
  body limits, polling limits, short-code attempt budget, and WAF limits match
  the runbooks. Do not claim WAF coverage for application authorization.
- Key rings and the GitHub Client Secret arrive through secret files. All
  Server replicas use the same active/retained keys and Provider revision.

## 3. Product smoke

Use two non-production GitHub users, two Teams, two browsers, and two separately
isolated CLI homes. Exercise Owner/Member and cross-Team cases, fresh/stale Web
Sessions, CLI approval/denial/expiry, login/setup/upload/read, revoke/remove,
disabled User, Provider outage, and the next request through another Server
replica. Expected 401/403/404 precedence must match the authorization matrix.

Block egress to `atape.dev` from an independently configured self-host Instance
while leaving GitHub reachable, then repeat Web login, CLI login, ingestion, and
read. This proves self-hosting does not depend on an ATape control plane.

## 4. Operations and rollback

- Restore the candidate PostgreSQL and Raw backup together in isolation;
  compare schema, Team/Project/Session/Raw/Search counts and Raw digest.
- Exercise the applicable fresh or mapped cutover, maintenance boundary, normal
  readiness, and rollback boundary. Record one non-secret backup/restore ID.
- Query security audit events for the smoke actions and verify expected actor,
  Team, action, outcome, and time without secret material.
- Inspect sampled application, edge, proxy, error, trace, and cache data using
  planted non-production canaries. No Cookie, token, OAuth code/state, user
  code, Provider secret/token, or local filesystem path may appear.
- Confirm alerts cover readiness, login/Provider errors, denied/revoked access,
  Device polling abuse, code-attempt exhaustion, cleanup backlog, ingestion
  failures, database/Raw failures, and elevated 5xx responses.

## 5. Signoff

Update `docs/releases/evidence/v0.2.0-staging.json` in a final evidence-only
commit: set every check to `passed`, attach HTTPS links to retained evidence,
record digests/restore ID/operator/timestamp, and set `status` to `completed`.
`testedCommit` is the exact candidate SHA. No production file may change after
that candidate; release verification allows only the attestation file to differ.

Then run:

```sh
node scripts/check-release-tag.mjs v0.2.0
```

Only after that command passes may the signed `v0.2.0` tag be pushed.
