"""FastAPI routers split per domain.

`main.py:create_app()` calls `app.include_router(<module>.router)` for
each. Each router owns its endpoints + the pydantic models on the
request/response shape + any private helper functions used only by
that domain.

Shared dependencies (settings, JWT auth, DB pool, structlog logger)
flow through `Depends()` rather than closures so each router is
independently importable and unit-testable.
"""

from . import chat, extract, health, images, mcp, summarize, url, whoami

__all__ = [
    "chat",
    "extract",
    "health",
    "images",
    "mcp",
    "summarize",
    "url",
    "whoami",
]
