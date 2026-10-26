# Node services (api, room-server). Only packages/core, the chosen service and the plans
# rooms are created from enter the image.
# docker build -f deploy/docker/node-service.Dockerfile --build-arg SERVICE=room-server -t pml/room-server .
FROM node:22-alpine
ARG SERVICE
ENV NODE_ENV=production PLANS_DIR=/app/plans
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/core/src packages/core/src
COPY services/${SERVICE} services/${SERVICE}
COPY apps/web/plans plans
RUN npm ci --omit=dev --workspace=services/${SERVICE}
WORKDIR /app/services/${SERVICE}
# node (numeric so Kubernetes can verify runAsNonRoot)
USER 1000
EXPOSE 8080
CMD ["node", "src/server.js"]
