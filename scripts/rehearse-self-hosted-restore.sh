#!/bin/sh
set -eu

repository=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
temporary=$(mktemp -d "$repository/.atape-restore-rehearsal.XXXXXX")
temporary=$(CDPATH= cd -- "$temporary" && pwd -P)
export COMPOSE_PROJECT_NAME=atape_rehearsal_$$
export ATAPE_COMPOSE_ENV_FILE=$temporary/rehearsal.env
export ATAPE_COMPOSE_OVERRIDE_FILE=$repository/compose.rehearsal.yaml
compose_files=$repository/compose.yaml:$ATAPE_COMPOSE_OVERRIDE_FILE

compose() {
  COMPOSE_FILE=$compose_files docker compose --project-directory "$repository" \
    --env-file "$ATAPE_COMPOSE_ENV_FILE" "$@"
}
cleanup() {
  code=$?
  trap - EXIT HUP INT TERM
  if [ "$code" -ne 0 ]; then
    compose ps >&2 || true
    compose logs --no-color database server >&2 || true
  fi
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  docker image rm "$COMPOSE_PROJECT_NAME-server:latest" >/dev/null 2>&1 || true
  rm -rf -- "$temporary"
  exit "$code"
}
trap cleanup EXIT HUP INT TERM

"$repository/scripts/generate-self-hosted-secrets.sh" "$temporary/secrets" >/dev/null
printf '%s\n' "github-rehearsal-secret" > "$temporary/secrets/github_client_secret"
chmod 600 "$temporary/secrets/github_client_secret"
mkdir "$temporary/postgres-data" "$temporary/raw-data"
port=$((30000 + ($$ % 20000)))
{
  printf 'ATAPE_PUBLIC_URL=http://127.0.0.1:%s\n' "$port"
  printf 'ATAPE_API_PUBLIC_URL=\n'
  printf 'ATAPE_COOKIE_DOMAIN=\n'
  printf 'ATAPE_DEVELOPMENT_ALLOW_HTTP=true\n'
  printf 'ATAPE_GITHUB_CLIENT_ID=github-rehearsal-client\n'
  printf 'ATAPE_AUTH_CUTOVER_MODE=normal\n'
  printf 'ATAPE_BIND_ADDRESS=127.0.0.1\n'
  printf 'ATAPE_PORT=%s\n' "$port"
  printf 'ATAPE_POSTGRES_PASSWORD_SECRET_FILE=%s\n' "$temporary/secrets/postgres_password"
  printf 'ATAPE_DATABASE_URL_SECRET_FILE=%s\n' "$temporary/secrets/database_url"
  printf 'ATAPE_AUTH_PEPPER_KEY_RING_SECRET_FILE=%s\n' "$temporary/secrets/auth_pepper_key_ring.json"
  printf 'ATAPE_AUTH_PRIVATE_STATE_KEY_RING_SECRET_FILE=%s\n' "$temporary/secrets/auth_private_state_key_ring.json"
  printf 'ATAPE_GITHUB_CLIENT_SECRET_FILE=%s\n' "$temporary/secrets/github_client_secret"
  printf 'ATAPE_REHEARSAL_POSTGRES_DIRECTORY=%s\n' "$temporary/postgres-data"
  printf 'ATAPE_REHEARSAL_RAW_DIRECTORY=%s\n' "$temporary/raw-data"
} > "$ATAPE_COMPOSE_ENV_FILE"

compose up --build --detach database server

ready=false
attempt=0
while [ "$attempt" -lt 60 ]; do
  if compose exec -T server wget -q -O /dev/null http://127.0.0.1:8080/readyz >/dev/null 2>&1; then
    ready=true
    break
  fi
  attempt=$((attempt + 1))
  sleep 1
done
if [ "$ready" != true ]; then
  compose logs server >&2
  printf '%s\n' "rehearsal server did not become ready" >&2
  exit 1
fi

sha256_stream() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  else
    shasum -a 256 | awk '{print $1}'
  fi
}
content='paired-restore-proof-v1'
content_sha=$(printf '%s\n' "$content" | sha256_stream)
content_shard=$(printf '%s' "$content_sha" | cut -c 1-2)
content_size=$(printf '%s\n' "$content" | wc -c | tr -d ' ')
compose exec -T database psql --username=atape --dbname=atape --set=ON_ERROR_STOP=1 --command="
BEGIN;
INSERT INTO auth_users (id, status, display_name)
VALUES ('01991b70-4d2b-7c96-a532-5818faba2e71', 'active', 'Restore Owner');
INSERT INTO workspace_teams (id, name, name_reported, slug)
VALUES ('restore-team', 'Restore Team', TRUE, 'restore-team');
INSERT INTO team_memberships (team_id, user_id, role, status)
VALUES ('restore-team', '01991b70-4d2b-7c96-a532-5818faba2e71', 'owner', 'active');
INSERT INTO canonical_projects (
  id, team_id, name, captured_through, project_type, repository_link_state
) VALUES ('restore-project', 'restore-team', 'Restore Project', clock_timestamp(), 'directory', 'not_applicable');
INSERT INTO canonical_sessions (
  id, project_id, source_key, revision, digest, title, summary, insight,
  actor_name, actor_harness, branch, status, capture_status, updated_at,
  reported_event_count, captured_by_user_id, capture_lineage
) VALUES (
  'restore-session', 'restore-project', 'restore-source', 1,
  repeat('a', 64), 'Restore Session', '', '', 'rehearsal', 'rehearsal', '',
  'ended', 'complete', clock_timestamp(), 0,
  '01991b70-4d2b-7c96-a532-5818faba2e71', 'authenticated'
);
INSERT INTO raw_objects (
  id, project_id, session_id, source_name, media_type, adapter_id,
  adapter_version, captured_at, client_redacted, current_generation, generation_count
) VALUES (
  'restore-object', 'restore-project', 'restore-session', 'restore.txt', 'text/plain',
  'restore-rehearsal', '1.0.0', clock_timestamp(), TRUE, 1, 1
);
INSERT INTO raw_generations (object_id, generation, size_bytes, chunk_count, finalized)
VALUES ('restore-object', 1, $content_size, 1, TRUE);
INSERT INTO raw_chunks (
  chunk_id, object_id, generation, ordinal, byte_offset, size_bytes,
  adapter_version, captured_at, final, sha256, storage_key
) VALUES (
  'restore-chunk', 'restore-object', 1, 1, 0, $content_size,
  '1.0.0', clock_timestamp(), TRUE, '$content_sha', 'sha256/$content_shard/$content_sha'
);
COMMIT;" >/dev/null

compose run --rm --no-deps -T --entrypoint sh server -eu -c '
  digest=$1
  content=$2
  shard=$(printf "%s" "$digest" | cut -c 1-2)
  mkdir -p "/var/lib/atape/raw/sha256/$shard"
  printf "%s\n" "$content" > "/var/lib/atape/raw/sha256/$shard/$digest"
' sh "$content_sha" "$content" >/dev/null

"$repository/scripts/self-hosted-backup.sh" "$temporary/backup"

compose exec -T database psql --username=atape --dbname=atape --set=ON_ERROR_STOP=1 \
  --command="UPDATE auth_users SET display_name = 'Mutated Owner' WHERE id = '01991b70-4d2b-7c96-a532-5818faba2e71'" >/dev/null
compose run --rm --no-deps -T --entrypoint sh server -eu -c '
  digest=$1
  shard=$(printf "%s" "$digest" | cut -c 1-2)
  printf "%s\n" "mutated-raw-content" > "/var/lib/atape/raw/sha256/$shard/$digest"
' sh "$content_sha" >/dev/null

"$repository/scripts/self-hosted-restore.sh" "$temporary/backup" --confirm-restore

display_name=$(compose exec -T database psql --username=atape --dbname=atape --tuples-only --no-align \
  --command="SELECT display_name FROM auth_users WHERE id = '01991b70-4d2b-7c96-a532-5818faba2e71'" | tr -d '\r\n')
restored_sha=$(compose run --rm --no-deps -T --entrypoint sh server -eu -c '
  digest=$1
  shard=$(printf "%s" "$digest" | cut -c 1-2)
  sha256sum "/var/lib/atape/raw/sha256/$shard/$digest" | awk "{print \$1}"
' sh "$content_sha" | tr -d '\r\n')
if [ "$display_name" != "Restore Owner" ] || [ "$restored_sha" != "$content_sha" ]; then
  printf 'restore rehearsal mismatch: display=%s raw=%s\n' "$display_name" "$restored_sha" >&2
  exit 1
fi

printf '%s\n' "rehearsed a consistent PostgreSQL + Raw backup, mutation, restore, and readiness cycle"
