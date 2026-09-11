# OpenCode publication rollout

OpenCode collection needs a Server with `atape.publication.v1`. Installing the CLI
or publishing npm packages does not deploy that Server. This procedure prepares
an explicit Server deployment and database migration; candidate preparation alone
does not authorize executing it on a live instance.

## Prepare the candidate and recovery point

Record the exact reviewed commit, passing CI/Security runs, Server/Web image
identities, current Server version, current schema version, complete Compose file
list and current image references. Build with `pnpm build:release:images <tag>`
from that commit; retain the previous images. Do not infer the deployed schema
from a package tag or the Web release marker.

Starting the new Server automatically migrates PostgreSQL, even with publication
disabled. A v0.4.8/schema-14 installation needs migrations 000015–000019 for
candidate preparation, validation, activation, Raw authority and Raw manifest
pagination. There is no schema downgrade procedure. An image-only rollback is
not a substitute for a compatible paired PostgreSQL/Raw recovery point.

After deployment authorization and before the first new Server startup, use the
[paired backup procedure](backup-and-restore.md), record its manifest and artifact
digests, and retain the matching secret files separately. It pauses application
writers and causes a maintenance outage. Rehearse recovery in isolation before
changing the live instance. Record any writes made after the recovery point that
would be lost by restoring it.

## Review and enable publication admission

The checked-in [example](../../deploy/publication-limits.example.json) is valid
configuration exercised by real HTTP/Collector tests and the restore rehearsal.
Review it against the instance's capacity before adopting or changing it:

| Setting | Example | Meaning |
| --- | --- | --- |
| `partBytes` | 4 MiB | Maximum retained Canonical part; Server hard ceiling is 4 MiB |
| `targetBytes` | 128 MiB | One complete Canonical target |
| `userPendingBytes` | 256 MiB | One user's pending Canonical candidate bytes |
| `parts` | 128 | Parts per candidate |
| `reservations` | 32 | Unexpired reservations per user, including activated ones |
| `leaseLifetimeMs` | 300,000 | Five-minute writer lease |
| `reservationLifetimeMs` | 900,000 | Fifteen-minute reservation |

Activated reservations continue consuming the reservation count until expiry,
so a rapid import can encounter backpressure before byte admission is exhausted.
Pending-byte admission does not include published bodies, Raw, metadata or total
physical disk usage. Monitor those separately. The client journal's 5 MiB unit
ceiling is not a Server part limit; the Collector negotiates Server admission.
Larger counts or lifetimes have independent resource consequences.

Set `ATAPE_PUBLICATION_LIMITS` to the reviewed single-line JSON in the deployment
environment file, then include `compose.publication.yaml`. Missing or empty JSON
fails Compose interpolation. Invalid nonempty JSON fails Server startup. Leave
the variable unset and omit the override to keep publication disabled.

For example, from the deployment checkout, after the reviewed JSON is in `.env`:

```sh
export COMPOSE_FILE="$PWD/compose.yaml:$PWD/compose.publication.yaml"
docker compose config --quiet
```

Include every existing topology override too. For the AWS dogfood deployment,
the persisted Web image override must be retained:

```sh
cd /opt/atape/app
export COMPOSE_FILE="$PWD/compose.yaml:$PWD/compose.publication.yaml:$PWD/compose.web-release.yaml"
docker compose config --quiet
```

Use that same `COMPOSE_FILE`, environment file and project name for normal
operation, backup and restore. A separate split-origin or custom-storage override
must remain in the list. The backup/restore helpers honor the full list; their
legacy `ATAPE_COMPOSE_OVERRIDE_FILE` is appended if set, so avoid duplication.
Record and pin the candidate Server image via `ATAPE_SERVER_IMAGE` in the same
deployment environment; `server-init` must use that same image.

## Deploy and verify

After authorization, a completed paired backup and candidate image verification,
start the candidate using the reviewed topology. Recreate `server-init` with the
matching image before the Server, retain normal dependency/readiness checks, and
verify migration completion and `/readyz`. Do not use an unreviewed build or
discard a persisted Web image override. Automatic AWS Web deployment only updates
Web and does not perform these Server steps.

Check `/api/v1/instance` for the new release and `atape.publication.v1`. Through
the normal authenticated CLI flow, confirm negotiated publication limits and
collect one controlled OpenCode 1.18.30 fixture in a test Project. Verify a complete
conversation, an unchanged repeat, background restart, configured Raw behavior
and retained published history after an explicit limit failure. Use controlled
history; do not print credentials or inspect personal source files for acceptance.
Keep the Server, CLI and Adapter version records with the results.

If acceptance fails, stop application writers and retain failure evidence. Select
the previous compatible Server image and original topology before using the
paired restore procedure, so readiness startup does not immediately reapply the
new migrations. Verify Canonical, Raw, Search, login and CLI behavior before
reopening traffic. Restore changes durable state and discards writes after its
recovery point; it is part of the authorized maintenance operation.
