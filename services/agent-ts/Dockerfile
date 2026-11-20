# Multi-stage Bun build — mirrors services/agent-py/Dockerfile.
# Stage 1: install deps. Stage 2: copy app + run non-root.
#
# Build context is the REPO ROOT (the service imports the shared
# `lib/` + `config/` trees), e.g.:
#   docker build -f services/agent-ts/Dockerfile -t hummingbird/agent-ts .
# The root `.dockerignore` keeps `.env*`, `node_modules`, `.next`,
# `.git` and `.claude` out of that context.
#
# The runtime image mirrors the repo layout under /srv so the tsconfig
# `paths` resolve unchanged (agent-ts's tsconfig has `baseUrl: "../.."`;
# files under lib/ resolve `@/*` via the root tsconfig):
#   /srv/services/agent-ts   ← the service (+ its own node_modules)
#   /srv/lib, /srv/config    ← shared code reused via `@/server/*`,
#                              `@/shared/*`, `@/config/*`
#   /srv/tsconfig.json       ← root tsconfig (paths for files under lib/)
#   /srv/node_modules        ← ROOT deps. `lib/` imports packages that are
#                              only in the root package.json (MCP SDK,
#                              extraction libs, undici, server-only, …);
#                              CI installs root deps for the same reason.

FROM oven/bun:1.3.9-slim AS deps
WORKDIR /srv

# Root deps for the reused `lib/` modules. Production only — dev deps
# (eslint, tailwind, typescript, …) are never imported at runtime.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Service deps.
COPY services/agent-ts/package.json services/agent-ts/bun.lock* ./services/agent-ts/
RUN cd services/agent-ts && bun install --frozen-lockfile --production

FROM oven/bun:1.3.9-slim AS runtime
ARG UID=1000
ARG GID=1000
RUN groupadd -g ${GID} app && useradd -m -u ${UID} -g app app
WORKDIR /srv/services/agent-ts

COPY --from=deps /srv/node_modules /srv/node_modules
COPY --from=deps /srv/services/agent-ts/node_modules ./node_modules
COPY package.json tsconfig.json /srv/
COPY lib /srv/lib
COPY config /srv/config
COPY services/agent-ts/ ./

USER app
EXPOSE 8001
# `--conditions=react-server` makes `import "server-only"` (in every
# reused `lib/server/*` module) resolve to its empty shim instead of
# throwing at boot — same flag as `bun run start` / `bun run test`.
CMD ["bun", "--conditions=react-server", "src/server.ts"]
