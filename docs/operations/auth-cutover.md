# v0.1.1 to v0.2 authenticated cutover

This runbook applies only to an installation with persisted pre-authentication
data. A fresh database is classified `fresh/completed` by migration and starts
directly in `normal` mode.

Do not assign ownership by editing tables. The cutover Module is deliberately
the only supported writer for this transition.

## 1. Quiesce and preserve the old epoch

Stop old v0.1.1 application writers, including every Collector, and create a
consistent PostgreSQL + Raw backup using the v0.1.1 procedure or an equivalent
storage snapshot. Keep the old image/tag and its configuration with that
backup. Do not restart v0.1.1 writers after the v0.2 migration begins.

Set these v0.2 values before its first start:

```dotenv
ATAPE_AUTH_CUTOVER_MODE=bootstrap
ATAPE_PUBLIC_URL=https://atape.example.com
```

Configure the GitHub Provider and authentication secret files as described in
[Self-hosting](self-hosting.md), then deploy v0.2. Embedded additive migrations
classify the non-empty installation as `mapped/prepared`; startup changes it to
`mapped/bootstrap`. During bootstrap, only login, current-account, Web Session,
Instance discovery, and health/readiness routes are available. All content and
CLI routes fail with `503 cutover_incomplete` before parsing credentials or
bodies.

## 2. Authenticate intended Owners

Each intended legacy Team Owner signs in through the configured GitHub entry.
The login creates an ATape User but grants no legacy Team access. List the
candidate IDs:

```sh
docker compose run --rm --no-deps server auth-cutover users > users.json
```

The document contains normalized User and External Identity metadata but no
Provider token or raw claim. Confirm identities out of band before mapping.

## 3. Create and review the complete mapping

Create `mapping.json` with every legacy Team exactly once, a unique lowercase
slug, and at least one active intended Owner:

```json
{
  "protocol": "atape.auth-cutover.v1",
  "teams": [
    {
      "legacyTeamId": "existing-team-id",
      "slug": "engineering",
      "ownerUserIds": ["01991b70-4d2b-7c96-a532-5818faba2e71"]
    }
  ]
}
```

Generate a plan without mutation:

```sh
docker compose run --rm --no-deps --volume "$PWD:/work:ro" \
  server auth-cutover plan \
  --mapping /work/mapping.json > reviewed-plan.json
```

Run this from the directory containing `mapping.json`; the one-off container
mounts that directory read-only. Do not bake operator documents into an image.
Review:

- `applicable` is true and `findings` is empty;
- Team, Project, legacy Session, Raw object, and Search document counts match
  the preflight inventory;
- every `changes` entry has the intended slug and Owner IDs;
- `mappingDigest`, `snapshotDigest`, and `snapshotSchemaVersion` are present;
- `auditEvents` matches the number of Team assignments plus final completion.

Any database mutation after planning makes the plan stale. Generate and review
a new plan; never edit a plan artifact to make it apply.

## 4. Apply exactly what was reviewed

Run `apply` with the same mapping and byte-for-byte reviewed plan:

```sh
docker compose run --rm --no-deps --volume "$PWD:/work:ro" \
  server auth-cutover apply \
  --mapping /work/mapping.json \
  --plan /work/reviewed-plan.json
```

The Module holds the maintenance lock, retakes the full snapshot, revalidates
all Users and Teams, and commits slugs, active Owner Memberships, audit events,
and `completed` in one transaction. A crash leaves none of those mutations
committed. Repeating the same completed mapping is safe; a different mapping is
rejected.

## 5. Enter normal serving

Change `.env` to:

```dotenv
ATAPE_AUTH_CUTOVER_MODE=normal
```

Recreate the services so they receive the new environment, then verify:

```sh
docker compose up -d --force-recreate server web
curl --fail https://atape.example.com/readyz
```

Normal startup refuses to listen unless the cutover is complete, every Team
has a slug and active Owner, live authentication references are configured, and
Raw storage is writable. It records `normal_serving_started_at` before serving.
Restart authenticated Collectors only after this succeeds; each user logs in
with their own CLI credential, and new captures receive authenticated lineage.

Legacy Sessions remain readable according to their Team Membership but retain
`legacy_anonymous` lineage and no `captured_by_user_id`. They cannot receive new
Canonical or Raw appends and are never relabeled as a new User's capture.
Legacy Git Projects remain `unknown` until an explicit repository relink; they
are not guessed from an unrelated local checkout.

## Rollback boundary

Before normal serving is recorded, the supported rollback is a full paired
restore of the pre-upgrade PostgreSQL and Raw snapshot followed by the matching
v0.1.1 binary. Do not point v0.1.1 at the migrated database.

After normal serving is recorded, an anonymous binary is not a supported
rollback. It cannot represent authenticated lineage and would reopen all
writes. The v0.2 Compose service passes only `ATAPE_DATABASE_URL_FILE`, which a
v0.1 image does not understand, so replacing only the server image fails closed
instead of starting it on the retained database. Do not defeat that barrier by
restoring the old Compose environment. Restrict traffic, keep the v0.2 data
epoch intact, and roll forward to a compatible authenticated build. If disaster
recovery is necessary, restore a complete authenticated PostgreSQL + Raw backup
with its matching key rings; never restore only one side or clear the cutover
ledger manually.
