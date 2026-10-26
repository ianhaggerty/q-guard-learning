# Node services (api, room-server). Only packages/core and the chosen service enter the image.
# docker build -f deploy/docker/node-service.Dockerfile --build-arg SERVICE=room-server -t pml/room-server .
FROM node:22-alpine
ARG SERVICE
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/core/src packages/core/src
COPY services/${SERVICE} services/${SERVICE}
RUN npm ci --omit=dev --workspace=services/${SERVICE}
WORKDIR /app/services/${SERVICE}
# node (numeric so Kubernetes can verify runAsNonRoot)
USER 1000
EXPOSE 8080
CMD ["node", "src/server.js"]
