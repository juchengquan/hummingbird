# Hummingbird agent service — Phase 0 image.
#
# Multi-stage build:
#   1. `builder` resolves deps via uv into a virtualenv.
#   2. `runtime` copies the venv + source into a slim image.
#
# Built on Python 3.12 to match the version pinned in pyproject.toml. The
# `uv` install on stage 1 keeps the runtime image free of build tools.
#
# Build context is the REPO ROOT (the service reads the shared model
# catalog `config/models.json` — the model allowlist — and the providers
# its routes name, `config/providers.json`), e.g.:
#   docker build -f services/agent-py/Dockerfile -t hummingbird/agent-py .
# The root `.dockerignore` keeps `.env*`, `.venv`, caches, `.git` and
# `.claude` out of that context.

# --- Stage 1: build ---------------------------------------------------------
FROM python:3.12-slim AS builder

# uv is a fast resolver/installer. Pinned by tag so the build is reproducible.
COPY --from=ghcr.io/astral-sh/uv:0.5.4 /uv /uvx /bin/

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never

WORKDIR /app

# Copy the dependency manifests first to maximise Docker-layer caching —
# changes to source code shouldn't bust the deps layer.
COPY services/agent-py/pyproject.toml services/agent-py/uv.lock* ./

# Optional extras: `--build-arg AGENT_PY_EXTRAS=sandbox` adds the code
# interpreter's microsandbox SDK (~55 MB; needs a KVM host at run time —
# README "Code interpreter"). Empty: no extras.
ARG AGENT_PY_EXTRAS=""

# Resolve + install into /app/.venv. `--no-install-project` keeps the project
# itself out so the layer doesn't bust on every source change.
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-install-project --no-dev ${AGENT_PY_EXTRAS:+--extra $AGENT_PY_EXTRAS}

# Now copy the project source and install it. This second layer is the only
# one that busts on a source change.
COPY services/agent-py/src ./src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev ${AGENT_PY_EXTRAS:+--extra $AGENT_PY_EXTRAS}


# --- Stage 2: runtime -------------------------------------------------------
FROM python:3.12-slim AS runtime

# Run as an unprivileged user. The agent service has no need for root.
RUN useradd --create-home --shell /bin/bash agent

WORKDIR /app

# Pull in the resolved venv + source from the builder.
COPY --from=builder --chown=agent:agent /app/.venv /app/.venv
COPY --from=builder --chown=agent:agent /app/src /app/src
# Model allowlist — read (and validated) at boot; a missing file fails
# startup. `MODELS_CONFIG_PATH` pins the location explicitly. The providers
# the catalog's routes name sit beside it (`model_routes.py`, wave 10).
COPY --chown=agent:agent config/models.json /app/config/models.json
COPY --chown=agent:agent config/providers.json /app/config/providers.json

ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    MODELS_CONFIG_PATH=/app/config/models.json

USER agent
EXPOSE 8000

# Phase 0 ship: a single uvicorn worker. Production scaling lives in the
# deploy target (host-dependent — see PLAN-agent-api.md "Deliberately
# deferred" section). Adding `--workers N` here would conflict with how
# most PaaS orchestrators expect to scale.
#
# --timeout-graceful-shutdown: uvicorn otherwise waits for every open
# connection (long-lived /v1/chat SSE streams) before running the
# lifespan shutdown that closes the DB pool. The poller's own stop starts
# on SIGTERM (main.install_shutdown_signal_hook) and takes at most
# SHUTDOWN_GRACE_SECONDS (8); cutting streams at 8 s keeps the whole
# shutdown inside Docker's 10 s stop timeout.
CMD ["uvicorn", "agent_py.main:app", "--host", "0.0.0.0", "--port", "8000", "--timeout-graceful-shutdown", "8"]
