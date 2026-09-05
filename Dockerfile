# syntax=docker/dockerfile:1

# --- base -------------------------------------------------------------------
FROM node:20-bookworm-slim AS base
WORKDIR /app
ENV NODE_ENV=development

# --- deps -------------------------------------------------------------------
# Installs all dependencies (including dev deps) against the container's Linux
# environment. Cached separately from source for fast rebuilds; the BuildKit
# cache mount keeps the npm download cache across builds.
FROM base AS deps
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

# --- dev --------------------------------------------------------------------
# Used by docker-compose (target: dev). Source is bind-mounted at runtime and
# node_modules lives in a named volume, so this image just needs the tooling.
# Stays root: the bind mount and the node_modules volume are root-owned, and
# dropping privileges here breaks `npm install` inside the container.
FROM deps AS dev
COPY . .
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=40s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm", "run", "dev"]

# --- build ------------------------------------------------------------------
# Compiles TypeScript -> dist/. The postbuild step copies the .sql migrations,
# which tsc does not emit; without them dist/server.js crashes in runMigrations.
FROM deps AS build
COPY . .
RUN npm run build && npm prune --omit=dev

# --- prod -------------------------------------------------------------------
# Slim runtime image: production deps + compiled output, reusing the pruned
# node_modules from the build stage instead of installing a second time.
FROM base AS prod
ENV NODE_ENV=production
COPY --chown=node:node package.json package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
# Published API contract served at /openapi.json.
COPY --chown=node:node openapi ./openapi
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
