# Backup and restore

ATape's durable state is a pair: PostgreSQL contains Canonical, Search, Raw
manifests, identity, authorization, audit, and cutover state; the Raw volume
contains immutable chunk bytes. Backing up or restoring only one side is not a
valid recovery point.

The bundled scripts target the root Compose topology. Set
`ATAPE_COMPOSE_ENV_FILE=/absolute/path/to/.env` when the deployment does not use
the repository's default `.env`. For split-origin deployments also set
`ATAPE_COMPOSE_OVERRIDE_FILE=compose.split-origin.yaml`. `COMPOSE_PROJECT_NAME`
is respected.

## Create a backup

Choose a path that does not yet exist on storage outside the Compose volumes:

```sh
./scripts/self-hosted-backup.sh /secure/off-host/atape-2026-09-06
```

The script validates Compose and requires the database to be running. It stops
the Web and server writers, emits a PostgreSQL custom dump and Raw tar archive,
records their SHA-256 digests plus schema/cutover metadata, and restores the
previous service-running state. This is a short maintenance outage by design.

The resulting directory contains:

```text
manifest.txt
postgres.dump
raw.tar.gz
```

Copy the directory to encrypted, access-controlled, off-host storage. Back up
the Compose secret files separately; they are deliberately excluded from the
data archive. Regularly test the copy on another host.

## Restore a backup

Use an isolated maintenance window and ensure the configured cutover mode
matches the backup (`bootstrap` for an incomplete mapped cutover, `normal` for
a completed or fresh installation):

```sh
./scripts/self-hosted-restore.sh /secure/off-host/atape-2026-09-06 \
  --confirm-restore
```

The confirmation flag is mandatory because restore changes live durable state.
Before touching it, the script verifies the artifact digests, rejects unexpected
Raw paths, validates the PostgreSQL archive, and stages a separate database and
Raw tree. It then retains the current database and `sha256` tree as recovery
copies, switches both, starts the server, and waits up to 30 seconds for
`/readyz`. Only a successful readiness check deletes the recovery copies. On a
failure it stops the application and attempts to switch both originals back.

After restore, verify login, one Canonical Session, one Raw object, Search, and
CLI collection before reopening external traffic. Check the cutover ledger via
`auth-cutover` only when the restored backup is in bootstrap; its operator
commands intentionally reject other phases.

## Rehearse

Run the destructive integration rehearsal only on a development Docker host:

```sh
pnpm test:self-hosting:restore
```

It creates an isolated Compose project and volumes, starts the real server and
PostgreSQL, inserts linked Canonical/Raw proof data, takes a paired backup,
mutates both stores, restores, verifies the database value, Raw digest, and
readiness, then destroys only those rehearsal resources.

Object-store Chunk Store Adapters must supply an equivalent consistent snapshot
and restore implementation before replacing the filesystem Adapter in
production. The Raw Archive health Interface alone is not a backup protocol.
