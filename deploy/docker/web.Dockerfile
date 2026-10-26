# Static client: apps/web with packages/core mounted at js/core/, served by unprivileged nginx.
# docker build -f deploy/docker/web.Dockerfile -t pml/web .
FROM node:22-alpine AS build
WORKDIR /app
COPY packages/core/src packages/core/src
COPY apps/web apps/web
RUN node apps/web/scripts/build.js

FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY deploy/docker/web-nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/build /usr/share/nginx/html
EXPOSE 8080
