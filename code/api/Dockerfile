# syntax=docker/dockerfile:1

# Build from the workspace root (code/) so the shared package is in context:
#   docker build -f api/Dockerfile .

# ---- Base ----
# Pin a specific Node version for reproducible builds. Alpine keeps the image small.
FROM node:24-alpine AS base
WORKDIR /app

# ---- Dependencies (all workspaces, for building) ----
# npm ci needs every workspace's package.json present, even for ones not built here.
FROM base AS deps
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY api/package.json api/
COPY hydrator/package.json hydrator/
RUN npm ci

# ---- Build (shared first — the service compiles against its dist) ----
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY shared shared
COPY api api
RUN npm run build -w shared && npm run build -w api

# ---- Production dependencies only (scoped to this workspace) ----
# -w api installs just this service's dependency closure (incl. @app/shared's),
# so the image doesn't ship the other workspaces' deps.
FROM base AS prod-deps
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY api/package.json api/
COPY hydrator/package.json hydrator/
RUN npm ci --omit=dev -w api

# ---- Runtime ----
FROM node:24-alpine AS runtime
# Release version baked in by scripts/release-images.sh; surfaces on every log line.
ARG SERVICE_VERSION=dev
ENV NODE_ENV=production \
    SERVICE_VERSION=${SERVICE_VERSION}
WORKDIR /app

# Copy only what's needed to run. Keep the workspace layout so the
# node_modules/@app/shared symlink resolves to shared/dist. Use the built-in
# non-root `node` user.
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/shared/dist ./shared/dist
COPY --from=build --chown=node:node /app/shared/package.json ./shared/
COPY --from=build --chown=node:node /app/api/dist ./api/dist
COPY --chown=node:node package.json ./
COPY --chown=node:node api/package.json ./api/

USER node
EXPOSE 3000

# Liveness check using Node's built-in fetch (no curl needed in the image).
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "api/dist/server.js"]
