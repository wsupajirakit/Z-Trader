# syntax=docker/dockerfile:1.7
#
# zTraderService: NestJS API + the React dashboard it serves, in one image.
#
#   docker build -t ztrader-service .
#
# Stages: api-deps / web-deps -> api-build / web-build -> prod-deps -> runtime.
# Only the runtime stage ships. It contains dist/, web/dist/, proto/, package.json and production
# node_modules, nothing else: no sources, no dev dependencies, no .env, no npm cache.

ARG NODE_IMAGE=node:24-alpine

# ---------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
WORKDIR /app
ENV npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false

# ---------------------------------------------------------------------------------------------------
# API dependencies (dev included: Nest CLI + TypeScript are needed to build)
FROM base AS api-deps
# mongodb-memory-server (e2e tests only) would otherwise download a ~100 MB mongod binary
ENV MONGOMS_DISABLE_POSTINSTALL=1
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci

# ---------------------------------------------------------------------------------------------------
# Dashboard dependencies (its own package.json and lockfile)
FROM base AS web-deps
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci

# ---------------------------------------------------------------------------------------------------
FROM api-deps AS api-build
COPY nest-cli.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build:api

# ---------------------------------------------------------------------------------------------------
FROM web-deps AS web-build
COPY web/ ./
RUN npm run build

# ---------------------------------------------------------------------------------------------------
# Production dependencies only. --ignore-scripts: no install hook of any dependency runs here,
# and none is needed at runtime (the app has no native modules).
FROM base AS prod-deps
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --omit=dev --ignore-scripts \
 # type declarations, source maps and docs are never loaded at runtime (about 45 MB). Licenses stay.
 && find node_modules -type f \( -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' \
        -o -name '*.map' -o \( -iname '*.md' ! -iname 'license*' \) \) -delete

# ---------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime

ARG VERSION=dev
ARG REVISION=unknown
ARG CREATED=unknown
LABEL org.opencontainers.image.title="zTraderService" \
      org.opencontainers.image.description="cTrader gold/FX trading service with a multi-user dashboard" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}" \
      org.opencontainers.image.licenses="UNLICENSED" \
      org.opencontainers.image.base.name="docker.io/library/node:24-alpine"

# tini as PID 1: forwards SIGTERM/SIGINT to node (Nest enableShutdownHooks closes the cTrader
# socket and Mongo cleanly) and reaps zombies.
# npm/npx/yarn are removed: the app never calls them at runtime, and they are the largest source of
# CVE noise in the base image. Run the CLI with `node dist/cli/create-user.js`.
RUN apk add --no-cache tini \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && mkdir -p /app/archive /app/data \
 && chown node:node /app/archive /app/data \
 # execution.service appends to ./order.log in the CWD. The code is read-only, so point it at the
 # data volume: it persists, and the container root filesystem can stay read-only.
 && ln -s /app/data/order.log /app/order.log

WORKDIR /app
ENV NODE_ENV=production \
    PORT=6500 \
    WEB_DIST_DIR=/app/web/dist \
    GOLD_ARCHIVE_DIR=/app/archive \
    GOLD_SETTINGS_FILE=/app/data/runtime-settings.json

# Application files stay owned by root, so the app user cannot modify its own code.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json ./
COPY proto ./proto
COPY --from=api-build /app/dist ./dist
COPY --from=web-build /app/web/dist ./web/dist

USER node
EXPOSE 6500
VOLUME ["/app/archive", "/app/data"]

# readiness = HTTP up AND MongoDB answers a ping. 127.0.0.1, not localhost: Alpine resolves
# localhost to ::1 first, and the app listens on 0.0.0.0.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD wget -q -T 4 -O /dev/null "http://127.0.0.1:${PORT}/health/ready" || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--enable-source-maps", "dist/main.js"]
