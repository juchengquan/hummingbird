# Hummingbird agent service — Phase 0 image.
#
# Multi-stage build:
#   1. `builder` resolves deps via uv into a virtualenv.
#   2. `runtime` copies the venv + source into a slim image.
#
# Built on Python 3.12 to match the version pinned in pyproject.toml. The
# `uv` install on stage 1 keeps the runtime image free of build tools.

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
COPY pyproject.toml uv.lock* ./

# Resolve + install into /app/.venv. `--no-install-project` keeps the project
# itself out so the layer doesn't bust on every source change.
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-install-project --no-dev

# Now copy the project source and install it. This second layer is the only
# one that busts on a source change.
COPY src ./src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev


# --- Stage 2: runtime -------------------------------------------------------
FROM python:3.12-slim AS runtime

# Run as an unprivileged user. The agent service has no need for root.
RUN useradd --create-home --shell /bin/bash agent

WORKDIR /app

# Pull in the resolved venv + source from the builder.
COPY --from=builder --chown=agent:agent /app/.venv /app/.venv
COPY --from=builder --chown=agent:agent /app/src /app/src

ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

USER agent
EXPOSE 8000

# Phase 0 ship: a single uvicorn worker. Production scaling lives in the
# deploy target (host-dependent — see PLAN-agent-api.md "Deliberately
# deferred" section). Adding `--workers N` here would conflict with how
# most PaaS orchestrators expect to scale.
CMD ["uvicorn", "agent_py.main:app", "--host", "0.0.0.0", "--port", "8000"]
