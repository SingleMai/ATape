FROM node:24-alpine AS build

RUN corepack enable
WORKDIR /source
COPY . .
RUN pnpm install --frozen-lockfile
ARG VITE_ATAPE_API_ORIGIN=""
ENV VITE_ATAPE_API_ORIGIN=${VITE_ATAPE_API_ORIGIN}
RUN pnpm --filter @atape/web build

FROM nginx:1.28-alpine

ARG NGINX_CONFIG=deploy/nginx.conf
COPY ${NGINX_CONFIG} /etc/nginx/conf.d/default.conf
COPY --from=build /source/apps/web/dist /usr/share/nginx/html

EXPOSE 8080
