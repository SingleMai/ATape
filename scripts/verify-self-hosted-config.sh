#!/bin/sh
set -eu

repository=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
temporary=$(mktemp -d "${TMPDIR:-/tmp}/atape-compose-contract.XXXXXX")
temporary=$(CDPATH= cd -- "$temporary" && pwd -P)
cleanup() {
  rm -rf -- "$temporary"
}
trap cleanup EXIT HUP INT TERM

"$repository/scripts/generate-self-hosted-secrets.sh" "$temporary/secrets" >/dev/null
printf '%s\n' "github-contract-secret" > "$temporary/secrets/github_client_secret"
chmod 600 "$temporary/secrets/github_client_secret"

write_common() {
  file=$1
  public_url=$2
  api_url=$3
  cookie_domain=$4
  allow_http=$5
  {
    printf 'ATAPE_PUBLIC_URL=%s\n' "$public_url"
    printf 'ATAPE_API_PUBLIC_URL=%s\n' "$api_url"
    printf 'ATAPE_COOKIE_DOMAIN=%s\n' "$cookie_domain"
    printf 'ATAPE_DEVELOPMENT_ALLOW_HTTP=%s\n' "$allow_http"
    printf 'ATAPE_GITHUB_CLIENT_ID=github-contract-client\n'
    printf 'ATAPE_AUTH_CUTOVER_MODE=normal\n'
    printf 'ATAPE_BIND_ADDRESS=127.0.0.1\n'
    printf 'ATAPE_PORT=18080\n'
    printf 'ATAPE_API_BIND_ADDRESS=127.0.0.1\n'
    printf 'ATAPE_API_PORT=18081\n'
    printf 'ATAPE_POSTGRES_PASSWORD_SECRET_FILE=%s\n' "$temporary/secrets/postgres_password"
    printf 'ATAPE_DATABASE_URL_SECRET_FILE=%s\n' "$temporary/secrets/database_url"
    printf 'ATAPE_AUTH_PEPPER_KEY_RING_SECRET_FILE=%s\n' "$temporary/secrets/auth_pepper_key_ring.json"
    printf 'ATAPE_AUTH_PRIVATE_STATE_KEY_RING_SECRET_FILE=%s\n' "$temporary/secrets/auth_private_state_key_ring.json"
    printf 'ATAPE_GITHUB_CLIENT_SECRET_FILE=%s\n' "$temporary/secrets/github_client_secret"
  } > "$file"
}

write_common "$temporary/loopback.env" "http://127.0.0.1:18080" "" "" "true"
docker compose --project-directory "$repository" --env-file "$temporary/loopback.env" \
  -f "$repository/compose.yaml" config --quiet
loopback_rendered=$(docker compose --project-directory "$repository" --env-file "$temporary/loopback.env" \
  -f "$repository/compose.yaml" config)
printf '%s\n' "$loopback_rendered" | grep -Fq 'ATAPE_DATABASE_URL_FILE: /run/secrets/database_url'
printf '%s\n' "$loopback_rendered" | grep -Fq 'condition: service_completed_successfully'
printf '%s\n' "$loopback_rendered" | grep -Fq 'network_mode: none'
printf '%s\n' "$loopback_rendered" | grep -Fq 'source: server-secrets'
printf '%s\n' "$loopback_rendered" | grep -Fq 'target: /run/atape-secrets'
printf '%s\n' "$loopback_rendered" | grep -Fq 'target: /run/secrets'
if printf '%s\n' "$loopback_rendered" | grep -Eq '^[[:space:]]+ATAPE_DATABASE_URL:'; then
  printf '%s\n' "database credential leaked into the Compose environment" >&2
  exit 1
fi

write_common "$temporary/same-origin.env" "https://self-hosted.example" "" "" "false"
docker compose --project-directory "$repository" --env-file "$temporary/same-origin.env" \
  -f "$repository/compose.yaml" config --quiet

write_common "$temporary/split-origin.env" "https://app.self-hosted.example" \
  "https://api.self-hosted.example" "self-hosted.example" "false"
docker compose --project-directory "$repository" --env-file "$temporary/split-origin.env" \
  -f "$repository/compose.yaml" -f "$repository/compose.split-origin.yaml" config --quiet
split_rendered=$(docker compose --project-directory "$repository" --env-file "$temporary/split-origin.env" \
  -f "$repository/compose.yaml" -f "$repository/compose.split-origin.yaml" config)
printf '%s\n' "$split_rendered" | grep -Fq 'NGINX_CONFIG: deploy/nginx.split-origin.conf'
printf '%s\n' "$split_rendered" | grep -Fq 'VITE_ATAPE_API_ORIGIN: https://api.self-hosted.example'
printf '%s\n' "$split_rendered" | grep -Fq 'host_ip: 127.0.0.1'
printf '%s\n' "$split_rendered" | grep -Fq 'published: "18081"'

printf '%s\n' "validated loopback, same-origin HTTPS, and split-origin HTTPS Compose topologies"
