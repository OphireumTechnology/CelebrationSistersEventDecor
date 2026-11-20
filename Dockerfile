# Multi-stage production Dockerfile for Celebration Sisters Event Decor (Railway)
# Uses deterministic npm ci backed by committed package-lock.json.
# Builds both the static React frontend (dist/) and compiled Express backend (dist-server/server.mjs).
# Never runs Vite dev or Vite preview in production.
# Debian glibc (bookworm-slim) is required by the committed Rolldown linux-x64-gnu native binding;
# Alpine/musl requires a different optional native package and fails the production image build.

FROM node:22-bookworm-slim AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

COPY package.json package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/dist-server ./dist-server
COPY --from=builder /app/db/migrations ./db/migrations
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/server ./server

RUN chown -R node:node /app
USER node

EXPOSE 3000

# One-time staging migration job; no HTTP server or healthcheck.
CMD ["./node_modules/.bin/tsx", "scripts/run-migrations.ts"]
