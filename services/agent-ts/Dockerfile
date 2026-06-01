# Multi-stage Bun build — mirrors services/agent-py/Dockerfile.
# Stage 1: install deps. Stage 2: copy app + run non-root.

FROM oven/bun:1.1-slim AS deps
WORKDIR /app
COPY services/agent-ts/package.json services/agent-ts/bun.lock* ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.1-slim AS runtime
ARG UID=1000
ARG GID=1000
RUN groupadd -g ${GID} app && useradd -m -u ${UID} -g app app
WORKDIR /app

# Application code. We mount `lib/` so the service can import the
# shared modules (`@/server/*`, `@/shared/*`).
COPY --from=deps /app/node_modules ./node_modules
COPY services/agent-ts/ ./
COPY lib ../../lib
COPY tsconfig.json ../../tsconfig.json

USER app
EXPOSE 8001
CMD ["bun", "src/server.ts"]
