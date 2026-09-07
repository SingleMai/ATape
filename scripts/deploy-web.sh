#!/usr/bin/env bash
# Interface: deploy-web.sh <full commit SHA> <extracted source directory>.
# The source must come from that verified commit. Only the Web service changes.
set -euo pipefail

sha=${1:?full commit SHA required}
source_directory=${2:?source directory required}
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid commit SHA' >&2; exit 1; }
test -f "$source_directory/deploy/web.Dockerfile"
app_directory=${ATAPE_APP_DIRECTORY:-/opt/atape/app}
state_directory=${ATAPE_DEPLOY_STATE_DIRECTORY:-/opt/atape}
origin=${ATAPE_LOCAL_ORIGIN:-http://127.0.0.1:8080}

exec 9>"$state_directory/.web-deploy.lock"
flock -w 900 9
cd "$app_directory"
override="$app_directory/compose.web-release.yaml"
compose=(docker compose -f "$app_directory/compose.yaml")
if [[ -f "$override" ]]; then compose+=(-f "$override"); fi
container=$("${compose[@]}" ps -q web)
test -n "$container"
previous_image=$(docker inspect --format '{{.Image}}' "$container")
current_sha=$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$container")
if [[ "$current_sha" == "$sha" ]] && \
    curl -fsS --max-time 10 "$origin/__web-release.json" | jq -e --arg sha "$sha" '.commit == $sha' >/dev/null; then
  echo "Web already serves $sha"
  exit 0
fi

api_origin=$("${compose[@]}" config --format json | jq -r '.services.web.build.args.VITE_ATAPE_API_ORIGIN // ""')
candidate="atape-web:candidate-$sha"
image="atape-web:$sha"
rollback="atape-web:rollback-$sha"
docker tag "$previous_image" "$rollback"
docker build --label "org.opencontainers.image.revision=$sha" \
  --build-arg "VITE_ATAPE_API_ORIGIN=$api_origin" \
  -f "$source_directory/deploy/web.Dockerfile" -t "$candidate" "$source_directory"

# Keep seven days of older hashed chunks for pages already open during rollout.
staging=$(mktemp -d "$state_directory/web-assets.XXXXXX")
asset_container=
cleanup() {
  if [[ -n "$asset_container" ]]; then docker rm "$asset_container" >/dev/null || true; fi
  rm -rf "$staging"
}
trap cleanup EXIT
asset_container=$(docker create "$previous_image")
docker cp "$asset_container:/usr/share/nginx/html/assets" "$staging/assets"
docker rm "$asset_container" >/dev/null
asset_container=
find "$staging/assets" -type f -mtime +7 -delete
jq -n --arg sha "$sha" '{commit:$sha}' > "$staging/revision.json"
cat > "$staging/Dockerfile" <<EOF
FROM $candidate
USER root
COPY --chown=nginx:nginx assets/ /usr/share/nginx/html/assets/
COPY --chown=nginx:nginx revision.json /usr/share/nginx/html/__web-release.json
USER nginx
EOF
docker build -t "$image" "$staging"

write_override() {
  printf 'services:\n  web:\n    image: "%s"\n    pull_policy: never\n' "$1" > "$override.tmp"
  mv "$override.tmp" "$override"
}
compose=(docker compose -f "$app_directory/compose.yaml" -f "$override")
write_override "$image"
if "${compose[@]}" up -d --no-deps --no-build --wait --wait-timeout 120 web && \
    curl -fsS --retry 3 --max-time 10 "$origin/__web-release.json" | jq -e --arg sha "$sha" '.commit == $sha' >/dev/null; then
  if [[ -f "$state_directory/.last-web-release" ]]; then
    cp "$state_directory/.last-web-release" "$state_directory/.previous-web-release"
  fi
  printf '%s\n' "$sha" > "$state_directory/.last-web-release"
  echo "Web deployed: $sha"
else
  echo "Web rollout failed; restoring $previous_image" >&2
  write_override "$rollback"
  "${compose[@]}" up -d --no-deps --no-build --wait --wait-timeout 120 web
  exit 1
fi
