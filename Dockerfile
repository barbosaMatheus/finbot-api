# syntax=docker/dockerfile:1

# --- base -------------------------------------------------------------------
FROM node:20-bookworm-slim AS base
WORKDIR /app
ENV NODE_ENV=development

# --- deps -------------------------------------------------------------------
# Installs all dependencies (including dev deps) against the container's Linux
# environment. Cached separately from source for fast rebuilds.
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

# --- dev --------------------------------------------------------------------
# Used by docker-compose (target: dev). Source is bind-mounted at runtime and
# node_modules lives in a named volume, so this image just needs the tooling.
FROM deps AS dev
COPY . .
EXPOSE 3000
CMD ["npm", "run", "dev"]

# --- build ------------------------------------------------------------------
# Compiles TypeScript -> dist/ for the production image.
FROM deps AS build
COPY . .
RUN npm run build

# --- prod -------------------------------------------------------------------
# Slim runtime image: production deps only + compiled output.
FROM base AS prod
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/server.js"]
