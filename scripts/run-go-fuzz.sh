#!/bin/sh
set -eu

repository=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
fuzz_time=${ATAPE_FUZZ_TIME:-10s}

cd "$repository/server"
go test ./internal/authentication -run '^$' -fuzz '^FuzzNormalizeReturnTo$' -fuzztime="$fuzz_time" -parallel=1
go test ./internal/authentication -run '^$' -fuzz '^FuzzNormalizeDeviceUserCode$' -fuzztime="$fuzz_time" -parallel=1
go test ./internal/adapters/httpapi -run '^$' -fuzz '^FuzzCanonicalRequestPath$' -fuzztime="$fuzz_time" -parallel=1
go test ./internal/adapters/httpapi -run '^$' -fuzz '^FuzzStartsWithJSONObject$' -fuzztime="$fuzz_time" -parallel=1
