# Multi-stage Bun build — mirrors services/agent-py/Dockerfile.
# Stage 1: install deps. Stage 2: copy app + run non-root.
#
# Build context is the REPO ROOT (the service reads the shared
# `config/` tree — model + provider catalogs, configuration not code),
# e.g.:
#   docker build -f services/agent-ts/Dockerfile -t hummingbird/agent-ts .
# The root `.dockerignore` keeps `.env*`, `node_modules`, `.next`,
# `.git` and `.claude` out of that context.
#
# agent-ts is self-contained: the Next app modules it used to reach
# into (`lib/`) are vendored under `src/vendor/` and every npm package
# it needs is in its own package.json. Only two inputs come from the
# repo:
#   /srv/services/agent-ts   ← the service (+ its own node_modules)
#   /srv/config              ← models.json + providers.json, imported
#                              as `@config/*` (tsconfig paths →
#                              `../../config/*`), so the image keeps the
#                              repo's relative layout for that one tree.

FROM oven/bun:1.3.9-slim AS deps
WORKDIR /srv/services/agent-ts

COPY services/agent-ts/package.json services/agent-ts/bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3.9-slim AS runtime
ARG UID=1000
ARG GID=1000
RUN groupadd -g ${GID} app && useradd -m -u ${UID} -g app app
WORKDIR /srv/services/agent-ts

COPY --from=deps /srv/services/agent-ts/node_modules ./node_modules
COPY config /srv/config
COPY services/agent-ts/ ./

USER app
EXPOSE 8001
# `--conditions=react-server` makes `import "server-only"` (kept in the
# vendored `src/vendor/server/*` copies) resolve to its empty shim
# instead of throwing at boot — same flag as `bun run start` /
# `bun run test`.
CMD ["bun", "--conditions=react-server", "src/server.ts"]
