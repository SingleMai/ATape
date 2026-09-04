FROM golang:1.24-alpine AS build

WORKDIR /source/server
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/atape-server ./cmd/atape-server

FROM alpine:3.21

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
