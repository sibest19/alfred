# WhatsApp ingester. Build from the repository root: docker build -f ingest/Dockerfile .
FROM node:24-bookworm-slim@sha256:8579e5fce559544b50072d05cc5d3b84b6a14d0989ae56c331d9e983a36a21f1 AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY db/package.json db/
COPY ingest/package.json ingest/
COPY api/package.json api/
RUN npm ci
COPY db db
COPY ingest ingest
RUN npm run build -w @alfred/db -w @alfred/ingest

FROM node:24-bookworm-slim@sha256:8579e5fce559544b50072d05cc5d3b84b6a14d0989ae56c331d9e983a36a21f1
ENV NODE_ENV=production MEDIA_DIR=/media HTTP_PORT=8080
WORKDIR /app
COPY package.json package-lock.json ./
COPY db/package.json db/
COPY ingest/package.json ingest/
COPY api/package.json api/
RUN npm ci --omit=dev -w @alfred/db -w @alfred/ingest && npm cache clean --force
COPY db/migrations db/migrations
COPY --from=build /app/db/dist db/dist
COPY --from=build /app/ingest/dist ingest/dist
WORKDIR /app/ingest
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
