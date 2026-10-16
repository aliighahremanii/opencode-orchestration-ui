# Multi-stage build for the read-only orchestration observer.
#
# The image runs two processes from one artifact:
#   - the Next.js web server  (`next start`)
#   - the long-lived collector (`node scripts/collector.ts`)
# They are started as separate services in docker-compose.yml, because they have
# different lifetimes and because only the collector needs upstream reachability.
#
# Node 24 is required: the application uses the built-in `node:sqlite` driver, so
# there is no native module to compile and no ABI to match.

FROM node:24-bookworm-slim AS deps
WORKDIR /app
# Only the manifests, so a source change does not invalidate the dependency layer.
COPY package.json bun.lock ./
# The project pins Bun as its package manager; use it when available so the
# lockfile is authoritative. Fall back to npm only for the install step, never
# for a lockfile rewrite.
RUN npm install --global bun@1.4.2 \
 && bun install --frozen-lockfile

FROM node:24-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# The build reads no secrets and contacts nothing: configuration is read at
# runtime, and the fixture upstream is local.
RUN ./node_modules/.bin/next build

FROM node:24-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Defaults match the compose service; override via the environment.
ENV ORCH_DATA_DIR=/data
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN apt-get update \
 && apt-get install --no-install-recommends --yes ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 1001 nodejs \
 && useradd --system --uid 1001 --gid nodejs observer

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.ts ./next.config.ts
COPY --from=builder /app/tsconfig.json ./tsconfig.json
# The collector and the migration tool run from source under Node's type
# stripping, so the TypeScript sources are part of the runtime artifact.
COPY --from=builder /app/lib ./lib
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/fixtures ./fixtures
COPY --from=builder /app/public ./public

# The database directory is a volume; create it with the right ownership so a
# fresh named volume is writable by the unprivileged user.
RUN mkdir -p /data && chown -R observer:nodejs /data
VOLUME ["/data"]

USER observer

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl --fail --silent --show-error http://127.0.0.1:3000/login >/dev/null || exit 1

# Default command is the web server. The collector service overrides it.
CMD ["./node_modules/.bin/next", "start"]
