# Multi-stage production Dockerfile for Celebration Sisters Event Decor (Railway)
# Uses deterministic npm ci backed by committed package-lock.json.
# Builds both the static React frontend (dist/) and compiled Express backend (dist-server/server.mjs).
# Never runs Vite dev or Vite preview in production.
# The committed lockfile includes Rolldown's glibc Linux binding; Alpine/musl requires
# a different optional native package and fails the production image build.

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
RUN npm ci --omit=dev --no-audit --no-fund

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/dist-server ./dist-server
COPY --from=builder /app/db/migrations ./db/migrations

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:' + (process.env.PORT || '3000') + '/health', response => process.exit(response.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "dist-server/server.mjs"]
