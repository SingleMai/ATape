#!/bin/sh
set -eu

usage() {
  printf '%s\n' "usage: $0 <new-backup-directory>"
}

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
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

target=$1
parent=$(dirname -- "$target")
name=$(basename -- "$target")
case "$name" in
  ""|.|..) printf '%s\n' "backup directory name is unsafe" >&2; exit 2 ;;
esac
if [ ! -d "$parent" ]; then
  printf 'backup parent does not exist: %s\n' "$parent" >&2
  exit 1
fi
parent=$(CDPATH= cd -- "$parent" && pwd -P)
target=$parent/$name
if [ -e "$target" ]; then
  printf 'refusing to overwrite existing backup path: %s\n' "$target" >&2
  exit 1
fi

compose config --quiet
running=$(compose ps --status running --services)
database_running=false
server_running=false
web_running=false
printf '%s\n' "$running" | grep -qx database && database_running=true || true
printf '%s\n' "$running" | grep -qx server && server_running=true || true
printf '%s\n' "$running" | grep -qx web && web_running=true || true
if [ "$database_running" != true ]; then
  printf '%s\n' "the Compose database service must be running" >&2
  exit 1
fi

umask 077
mkdir "$target"
finished=false
restore_running_services() {
  code=$?
  trap - EXIT HUP INT TERM
  if [ "$server_running" = true ]; then
    compose start server >/dev/null 2>&1 || true
  fi
  if [ "$web_running" = true ]; then
    compose start web >/dev/null 2>&1 || true
  fi
  if [ "$finished" != true ]; then
    printf 'backup did not complete; partial output remains at %s\n' "$target" >&2
  fi
  exit "$code"
}
trap restore_running_services EXIT HUP INT TERM

if [ "$web_running" = true ]; then
  compose stop web >/dev/null
fi
if [ "$server_running" = true ]; then
  compose stop server >/dev/null
fi

compose exec -T database pg_dump --username=atape --dbname=atape \
  --format=custom --no-owner --no-privileges > "$target/postgres.dump"
compose run --rm --no-deps -T --entrypoint tar server \
  -C /var/lib/atape/raw -czf - . > "$target/raw.tar.gz"

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

schema_version=$(compose exec -T database psql --username=atape --dbname=atape --tuples-only --no-align \
  --command='SELECT COALESCE(MAX(version), 0) FROM atape_schema_migrations' | tr -d '\r\n')
cutover=$(compose exec -T database psql --username=atape --dbname=atape --tuples-only --no-align --field-separator='|' \
  --command="SELECT installation_kind, status, COALESCE(normal_serving_started_at::text, '') FROM auth_cutover_ledger WHERE protocol_version = 'auth-v1'" | tr -d '\r\n')
raw_chunk_rows=$(compose exec -T database psql --username=atape --dbname=atape --tuples-only --no-align \
  --command='SELECT COUNT(*) FROM raw_chunks' | tr -d '\r\n')
IFS='|' read -r installation_kind cutover_phase normal_serving_started_at <<EOF
$cutover
EOF

postgres_sha256=$(sha256_file "$target/postgres.dump")
raw_sha256=$(sha256_file "$target/raw.tar.gz")
created_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
{
  printf 'format=atape.backup.v1\n'
  printf 'created_at=%s\n' "$created_at"
  printf 'schema_version=%s\n' "$schema_version"
  printf 'installation_kind=%s\n' "$installation_kind"
  printf 'cutover_phase=%s\n' "$cutover_phase"
  printf 'normal_serving_started_at=%s\n' "$normal_serving_started_at"
  printf 'raw_chunk_rows=%s\n' "$raw_chunk_rows"
  printf 'postgres_sha256=%s\n' "$postgres_sha256"
  printf 'raw_sha256=%s\n' "$raw_sha256"
} > "$target/manifest.txt"

finished=true
printf 'created consistent PostgreSQL and Raw backup at %s\n' "$target"
