# syntax=docker/dockerfile:1

# Build from the workspace root (code/) so the shared package is in context:
#   docker build -f hydrator/Dockerfile .

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
COPY hydrator hydrator
RUN npm run build -w shared && npm run build -w hydrator

# ---- Production dependencies only (scoped to this workspace) ----
# -w hydrator installs just this service's dependency closure (incl.
# @app/shared's), so the image doesn't ship the other workspaces' deps.
FROM base AS prod-deps
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY api/package.json api/
COPY hydrator/package.json hydrator/
RUN npm ci --omit=dev -w hydrator

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
COPY --from=build --chown=node:node /app/hydrator/dist ./hydrator/dist
# SQL migrations, applied by the app at the start of each run (dist/../drizzle).
COPY --from=build --chown=node:node /app/hydrator/drizzle ./hydrator/drizzle
COPY --chown=node:node package.json ./
COPY --chown=node:node hydrator/package.json ./hydrator/

USER node

# Run-to-completion job: no ports, no HEALTHCHECK — success is exit code 0.
CMD ["node", "hydrator/dist/main.js"]
