# HTTP API. Build from the repository root: docker build -f api/Dockerfile .
FROM node:26-bookworm-slim@sha256:bc0a2afd3b74ce12222fc8bab99271e66257f021078f5f4a5d687a77d280c1d9 AS build
WORKDIR /app
RUN npm install --global pnpm@12.16.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY db/package.json db/
COPY ingest/package.json ingest/
COPY api/package.json api/
RUN pnpm install --frozen-lockfile
COPY db db
COPY api api
RUN pnpm --filter @alfred/api... run build
RUN pnpm --filter @alfred/api deploy --prod /prod/api

FROM node:26-bookworm-slim@sha256:bc0a2afd3b74ce12222fc8bab99271e66257f021078f5f4a5d687a77d280c1d9
ENV NODE_ENV=production HTTP_PORT=8080
WORKDIR /app
COPY --from=build /prod/api ./
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
