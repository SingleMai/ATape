#!/bin/sh
set -eu

usage() {
  printf '%s\n' "usage: $0 <new-secret-directory>"
}

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  usage >&2
  exit 2
fi

target=$1
if [ -e "$target" ]; then
  printf 'refusing to overwrite existing path: %s\n' "$target" >&2
  exit 1
fi
if ! command -v openssl >/dev/null 2>&1; then
  printf '%s\n' "openssl is required" >&2
  exit 1
fi

umask 077
mkdir -p "$target"
password=$(openssl rand -hex 32)
pepper=$(openssl rand -base64 32 | tr -d '\n')
private_state=$(openssl rand -base64 32 | tr -d '\n')

printf '%s\n' "$password" > "$target/postgres_password"
printf 'postgres://atape:%s@database:5432/atape?sslmode=disable\n' "$password" > "$target/database_url"
printf '{"active":"v1","keys":{"v1":"%s"}}\n' "$pepper" > "$target/auth_pepper_key_ring.json"
printf '{"active":"v1","keys":{"v1":"%s"}}\n' "$private_state" > "$target/auth_private_state_key_ring.json"

printf '%s\n' "Generated PostgreSQL and authentication secrets in $target."
printf '%s\n' "Create $target/github_client_secret with the GitHub OAuth App secret and mode 0600 before startup."
