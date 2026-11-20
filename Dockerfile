# Multi-stage production Dockerfile for Celebration Sisters Event Decor (Railway)
# Uses deterministic npm ci backed by committed package-lock.json.
# Builds both the static React frontend (dist/) and compiled Express backend (dist-server/server.mjs).
# Never runs Vite dev or Vite preview in production.
# Debian glibc (bookworm-slim) is required by the committed Rolldown linux-x64-gnu native binding;
# The runtime must match the native linux-x64-gnu binding.

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

# Container health uses the existing application liveness endpoint, without external tools.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD node -e "require('node:http').get('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"
CMD ["node", "dist-server/server.mjs"]
