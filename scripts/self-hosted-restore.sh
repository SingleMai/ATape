#!/bin/sh
set -eu

usage() {
  printf '%s\n' "usage: $0 <backup-directory> --confirm-restore"
}

if [ "$#" -ne 2 ] || [ -z "$1" ] || [ "$2" != "--confirm-restore" ]; then
  usage >&2
  exit 2
fi

repository=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
compose_files=$repository/compose.yaml
if [ -n "${ATAPE_COMPOSE_OVERRIDE_FILE:-}" ]; then
  case "$ATAPE_COMPOSE_OVERRIDE_FILE" in
    /*) override_file=$ATAPE_COMPOSE_OVERRIDE_FILE ;;
    *) override_file=$repository/$ATAPE_COMPOSE_OVERRIDE_FILE ;;
  esac
  compose_files=$compose_files:$override_file
fi
compose() {
  if [ -n "${ATAPE_COMPOSE_ENV_FILE:-}" ]; then
    COMPOSE_FILE=$compose_files docker compose --project-directory "$repository" \
      --env-file "$ATAPE_COMPOSE_ENV_FILE" "$@"
  else
    COMPOSE_FILE=$compose_files docker compose --project-directory "$repository" "$@"
  fi
}

backup=$1
if [ ! -d "$backup" ] || [ -L "$backup" ]; then
  printf 'backup must be a real directory: %s\n' "$backup" >&2
  exit 1
fi
backup=$(CDPATH= cd -- "$backup" && pwd -P)
for artifact in manifest.txt postgres.dump raw.tar.gz; do
  if [ ! -f "$backup/$artifact" ] || [ -L "$backup/$artifact" ]; then
    printf 'missing or unsafe backup artifact: %s\n' "$artifact" >&2
    exit 1
  fi
done

manifest_value() {
  key=$1
  value=$(sed -n "s/^${key}=//p" "$backup/manifest.txt")
  count=$(sed -n "s/^${key}=//p" "$backup/manifest.txt" | wc -l | tr -d ' ')
  if [ "$count" -ne 1 ] || [ -z "$value" ]; then
    printf 'invalid backup manifest field: %s\n' "$key" >&2
    exit 1
  fi
  printf '%s\n' "$value"
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

if [ "$(manifest_value format)" != "atape.backup.v1" ]; then
  printf '%s\n' "unsupported backup format" >&2
  exit 1
fi
expected_postgres=$(manifest_value postgres_sha256)
expected_raw=$(manifest_value raw_sha256)
if [ "$(sha256_file "$backup/postgres.dump")" != "$expected_postgres" ] || \
   [ "$(sha256_file "$backup/raw.tar.gz")" != "$expected_raw" ]; then
  printf '%s\n' "backup digest verification failed" >&2
  exit 1
fi

invalid_entry=false
while IFS= read -r entry; do
  case "$entry" in
    .|./|./sha256|./sha256/*) ;;
    *) invalid_entry=true ;;
  esac
done <<EOF
$(tar -tzf "$backup/raw.tar.gz")
EOF
if [ "$invalid_entry" = true ]; then
  printf '%s\n' "Raw archive contains an unexpected path" >&2
  exit 1
fi

compose config --quiet
compose exec -T database pg_restore --list < "$backup/postgres.dump" >/dev/null
running=$(compose ps --status running --services)
server_running=false
web_running=false
printf '%s\n' "$running" | grep -qx server && server_running=true || true
printf '%s\n' "$running" | grep -qx web && web_running=true || true
if ! printf '%s\n' "$running" | grep -qx database; then
  printf '%s\n' "the Compose database service must be running" >&2
  exit 1
fi

if [ "$web_running" = true ]; then
  compose stop web >/dev/null
fi
if [ "$server_running" = true ]; then
  compose stop server >/dev/null
fi

suffix=$(date -u '+%Y%m%d%H%M%S')_$$
stage_database=atape_restore_$suffix
previous_database=atape_previous_$suffix
raw_switched=false
database_original_renamed=false
database_switched=false
completed=false

recover() {
  code=$?
  trap - EXIT HUP INT TERM
  if [ "$completed" != true ]; then
    compose stop web server >/dev/null 2>&1 || true
    if [ "$database_switched" = true ]; then
      compose exec -T database dropdb --username=atape --force atape >/dev/null 2>&1 || true
      compose exec -T database psql --username=atape --dbname=postgres --set=ON_ERROR_STOP=1 \
        --command="ALTER DATABASE $previous_database RENAME TO atape" >/dev/null 2>&1 || true
    elif [ "$database_original_renamed" = true ]; then
      compose exec -T database psql --username=atape --dbname=postgres --set=ON_ERROR_STOP=1 \
        --command="ALTER DATABASE $previous_database RENAME TO atape" >/dev/null 2>&1 || true
    else
      compose exec -T database dropdb --username=atape --force "$stage_database" >/dev/null 2>&1 || true
    fi
    if [ "$raw_switched" = true ]; then
      compose run --rm --no-deps -T --entrypoint sh server -eu -c '
        root=/var/lib/atape/raw
        previous=$root/.atape-restore-previous-$1
        rm -rf -- "$root/sha256"
        if [ -d "$previous/sha256" ]; then mv "$previous/sha256" "$root/sha256"; fi
        rmdir "$previous" 2>/dev/null || true
      ' sh "$suffix" >/dev/null 2>&1 || true
    else
      compose run --rm --no-deps -T --entrypoint sh server -eu -c '
        rm -rf -- "/var/lib/atape/raw/.atape-restore-stage-$1" \
          "/var/lib/atape/raw/.atape-restore-previous-$1"
      ' sh "$suffix" >/dev/null 2>&1 || true
    fi
    if [ "$server_running" = true ]; then compose start server >/dev/null 2>&1 || true; fi
    if [ "$web_running" = true ]; then compose start web >/dev/null 2>&1 || true; fi
    printf '%s\n' "restore failed; the previous database and Raw tree were recovered when possible" >&2
  fi
  exit "$code"
}
trap recover EXIT HUP INT TERM

compose exec -T database createdb --username=atape "$stage_database"
compose exec -T database pg_restore --username=atape --dbname="$stage_database" \
  --no-owner --no-privileges --exit-on-error < "$backup/postgres.dump"

expected_schema=$(manifest_value schema_version)
expected_raw_rows=$(manifest_value raw_chunk_rows)
expected_installation=$(manifest_value installation_kind)
expected_cutover_phase=$(manifest_value cutover_phase)
restored_schema=$(compose exec -T database psql --username=atape --dbname="$stage_database" --tuples-only --no-align \
  --command='SELECT COALESCE(MAX(version), 0) FROM atape_schema_migrations' | tr -d '\r\n')
restored_raw_rows=$(compose exec -T database psql --username=atape --dbname="$stage_database" --tuples-only --no-align \
  --command='SELECT COUNT(*) FROM raw_chunks' | tr -d '\r\n')
restored_cutover=$(compose exec -T database psql --username=atape --dbname="$stage_database" --tuples-only --no-align --field-separator='|' \
  --command="SELECT installation_kind, status FROM auth_cutover_ledger WHERE protocol_version = 'auth-v1'" | tr -d '\r\n')
if [ "$restored_schema" != "$expected_schema" ] || [ "$restored_raw_rows" != "$expected_raw_rows" ] || \
   [ "$restored_cutover" != "$expected_installation|$expected_cutover_phase" ]; then
  printf '%s\n' "staged PostgreSQL restore failed manifest validation" >&2
  exit 1
fi

compose run --rm --no-deps -T --entrypoint sh server -eu -c '
  root=/var/lib/atape/raw
  stage=$root/.atape-restore-stage-$1
  previous=$root/.atape-restore-previous-$1
  test ! -e "$stage"
  test ! -e "$previous"
  mkdir "$stage" "$previous"
  tar -C "$stage" -xzf -
' sh "$suffix" < "$backup/raw.tar.gz"

compose run --rm --no-deps -T --entrypoint sh server -eu -c '
  root=/var/lib/atape/raw
  stage=$root/.atape-restore-stage-$1
  previous=$root/.atape-restore-previous-$1
  if [ -d "$root/sha256" ]; then mv "$root/sha256" "$previous/sha256"; fi
  if [ -d "$stage/sha256" ]; then mv "$stage/sha256" "$root/sha256"; else mkdir "$root/sha256"; fi
  rmdir "$stage"
' sh "$suffix"
raw_switched=true

compose exec -T database psql --username=atape --dbname=postgres --set=ON_ERROR_STOP=1 \
  --command="SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'atape' AND pid <> pg_backend_pid()" >/dev/null
compose exec -T database psql --username=atape --dbname=postgres --set=ON_ERROR_STOP=1 \
  --command="ALTER DATABASE atape RENAME TO $previous_database" >/dev/null
database_original_renamed=true
compose exec -T database psql --username=atape --dbname=postgres --set=ON_ERROR_STOP=1 \
  --command="ALTER DATABASE $stage_database RENAME TO atape" >/dev/null
database_switched=true

compose up -d --no-deps server >/dev/null
ready=false
attempt=0
while [ "$attempt" -lt 30 ]; do
  if compose exec -T server wget -q -O /dev/null http://127.0.0.1:8080/readyz >/dev/null 2>&1; then
    ready=true
    break
  fi
  attempt=$((attempt + 1))
  sleep 1
done
if [ "$ready" != true ]; then
  printf '%s\n' "restored server did not become ready" >&2
  exit 1
fi

compose exec -T database dropdb --username=atape --force "$previous_database"
compose run --rm --no-deps -T --entrypoint sh server -eu -c '
  rm -rf -- "/var/lib/atape/raw/.atape-restore-previous-$1"
' sh "$suffix"

if [ "$server_running" != true ]; then
  compose stop server >/dev/null
fi
if [ "$web_running" = true ]; then
  compose start web >/dev/null
fi
completed=true
printf 'restored and verified PostgreSQL and Raw backup from %s\n' "$backup"
