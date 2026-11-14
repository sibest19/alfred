# WhatsApp ingester. Build from the repository root: docker build -f ingest/Dockerfile .
FROM node:26-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 AS build
WORKDIR /app
RUN npm install --global pnpm@12.16.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY db/package.json db/
COPY ingest/package.json ingest/
COPY api/package.json api/
RUN pnpm install --frozen-lockfile
COPY db db
COPY ingest ingest
RUN pnpm --filter @alfred/ingest... run build
RUN pnpm --filter @alfred/ingest deploy --prod /prod/ingest

FROM node:26-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1
ENV NODE_ENV=production MEDIA_DIR=/media HTTP_PORT=8080
WORKDIR /app
COPY --from=build /prod/ingest ./
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
