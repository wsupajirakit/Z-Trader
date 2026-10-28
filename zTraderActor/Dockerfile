# syntax=docker/dockerfile:1

# ---- dependencies (production only, no install scripts) ----
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# ---- runtime ----
FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app

# Code stays owned by root and read-only for the app user.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# Run node directly (not via npm) so SIGTERM reaches the app for a graceful shutdown.
CMD ["node", "src/server.js"]
