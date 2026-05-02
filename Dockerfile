# syntax=docker/dockerfile:1.7

# ---------- Stage 1: build ----------
FROM node:22-alpine AS builder

# Enable pnpm via corepack (shipped with Node 22).
RUN corepack enable

WORKDIR /app

# Install dependencies first to leverage Docker layer cache.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Copy source and TypeScript config, then build.
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

# Prune devDependencies for the runtime stage.
RUN pnpm prune --prod

# ---------- Stage 2: runtime ----------
FROM node:22-alpine AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

WORKDIR /app

# Copy only what the runtime needs.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json

# Run as the unprivileged `node` user (UID 1000) baked into node:alpine.
USER node

EXPOSE 3000

# Healthcheck hits /healthz once Phase 4 wires the route.
# Returns failure until then; that's expected for the Phase 0 stub.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --quiet --spider http://localhost:3000/healthz || exit 1

CMD ["node", "dist/index.js"]
