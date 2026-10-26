# Static clients served by unprivileged nginx: the editor (apps/web) at / and the
# multiplayer client (apps/play) at /play/, each with packages/core at its js/core/.
# docker build -f deploy/docker/web.Dockerfile -t pml/web .
FROM node:22-alpine AS build
WORKDIR /app
COPY packages/core/src packages/core/src
COPY apps/web apps/web
COPY apps/play apps/play
RUN node apps/web/scripts/build.js && node apps/play/scripts/build.js

FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY deploy/docker/web-nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/build /usr/share/nginx/html
COPY --from=build /app/apps/play/build /usr/share/nginx/html/play
EXPOSE 8080
