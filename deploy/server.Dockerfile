ARG ATAPE_RELEASE_VERSION=0.2.0
ARG ATAPE_RELEASE_EPOCH=auth-v1
ARG ATAPE_MINIMUM_CLI_VERSION=0.2.0

FROM golang:1.25.14-alpine AS build

ARG ATAPE_RELEASE_VERSION
ARG ATAPE_RELEASE_EPOCH
ARG ATAPE_MINIMUM_CLI_VERSION

WORKDIR /source/server
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ ./
RUN CGO_ENABLED=0 go build -trimpath \
    -ldflags="-s -w -X github.com/SingleMai/ATape/server/internal/releaseinfo.Version=${ATAPE_RELEASE_VERSION} -X github.com/SingleMai/ATape/server/internal/releaseinfo.AuthEpoch=${ATAPE_RELEASE_EPOCH} -X github.com/SingleMai/ATape/server/internal/releaseinfo.MinimumCLIVersion=${ATAPE_MINIMUM_CLI_VERSION}" \
    -o /out/atape-server ./cmd/atape-server

FROM alpine:3.21

ARG ATAPE_RELEASE_VERSION
ARG ATAPE_RELEASE_EPOCH
ARG ATAPE_MINIMUM_CLI_VERSION
LABEL org.opencontainers.image.title="ATape Server" \
      org.opencontainers.image.version="${ATAPE_RELEASE_VERSION}" \
      dev.atape.auth-epoch="${ATAPE_RELEASE_EPOCH}" \
      dev.atape.minimum-cli-version="${ATAPE_MINIMUM_CLI_VERSION}"

RUN apk add --no-cache ca-certificates \
    && addgroup -S atape \
    && adduser -S -G atape -h /var/lib/atape atape \
    && mkdir -p /var/lib/atape/raw \
    && chown -R atape:atape /var/lib/atape
COPY --from=build /out/atape-server /usr/local/bin/atape-server

USER atape
EXPOSE 8080
VOLUME ["/var/lib/atape/raw"]
ENTRYPOINT ["/usr/local/bin/atape-server"]
