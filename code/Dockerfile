# syntax=docker/dockerfile:1

# ---- Base ----
# Pin a specific Node version for reproducible builds. Alpine keeps the image small.
FROM node:24-alpine AS base
WORKDIR /app

# ---- Dependencies (all, for building) ----
FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm ci

# ---- Build (compile TypeScript -> dist) ----
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---- Production dependencies only ----
FROM base AS prod-deps
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# ---- Runtime ----
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Copy only what's needed to run. Use the built-in non-root `node` user.
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

USER node
EXPOSE 3000

# Liveness check using Node's built-in fetch (no curl needed in the image).
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
