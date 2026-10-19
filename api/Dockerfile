# HTTP API. Build from the repository root: docker build -f api/Dockerfile .
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY db/package.json db/
COPY ingest/package.json ingest/
COPY api/package.json api/
RUN npm ci
COPY db db
COPY api api
RUN npm run build -w @alfred/db -w @alfred/api

FROM node:24-bookworm-slim
ENV NODE_ENV=production HTTP_PORT=8080
WORKDIR /app
COPY package.json package-lock.json ./
COPY db/package.json db/
COPY ingest/package.json ingest/
COPY api/package.json api/
RUN npm ci --omit=dev -w @alfred/db -w @alfred/api && npm cache clean --force
COPY db/migrations db/migrations
COPY --from=build /app/db/dist db/dist
COPY --from=build /app/api/dist api/dist
WORKDIR /app/api
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
