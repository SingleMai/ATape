FROM node:24-alpine AS build

RUN corepack enable
WORKDIR /source
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @atape/web build

FROM nginx:1.28-alpine

COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /source/apps/web/dist /usr/share/nginx/html

EXPOSE 8080
