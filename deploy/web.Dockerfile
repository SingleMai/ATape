ARG ATAPE_RELEASE_VERSION=0.2.0
ARG ATAPE_RELEASE_EPOCH=auth-v1
ARG ATAPE_MINIMUM_CLI_VERSION=0.2.0

FROM node:24-alpine AS build

RUN corepack enable
WORKDIR /source
COPY . .
RUN pnpm install --frozen-lockfile
ARG VITE_ATAPE_API_ORIGIN=""
ENV VITE_ATAPE_API_ORIGIN=${VITE_ATAPE_API_ORIGIN}
RUN pnpm --filter @atape/web build

FROM alpine:3.23

ARG ATAPE_RELEASE_VERSION
ARG ATAPE_RELEASE_EPOCH
ARG ATAPE_MINIMUM_CLI_VERSION
LABEL org.opencontainers.image.title="ATape Web" \
      org.opencontainers.image.version="${ATAPE_RELEASE_VERSION}" \
      dev.atape.auth-epoch="${ATAPE_RELEASE_EPOCH}" \
      dev.atape.minimum-cli-version="${ATAPE_MINIMUM_CLI_VERSION}"

ARG NGINX_CONFIG=deploy/nginx.conf
RUN apk upgrade --no-cache \
    && apk add --no-cache nginx \
    && rm -f /etc/nginx/http.d/default.conf \
    && sed -i '/^user nginx;$/d' /etc/nginx/nginx.conf \
    && mkdir -p /run/nginx /var/lib/nginx/tmp /var/log/nginx \
    && chown -R nginx:nginx /run/nginx /var/lib/nginx /var/log/nginx
COPY ${NGINX_CONFIG} /etc/nginx/http.d/default.conf
COPY --from=build /source/apps/web/dist /usr/share/nginx/html

USER nginx
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
