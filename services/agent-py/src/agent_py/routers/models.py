"""`GET /v1/models` — the catalog models this deploy can run (wave 10, Q119).

The `config/models.json` ids a provider is configured for here
(`model_routes.py`), in catalog order, each with whether background tasks run
on it. Public: it reveals which providers have keys, nothing else. The
browser's model picker offers these on agent-py.
"""

from __future__ import annotations

from fastapi import APIRouter

from ..contract import models
from ..model_allowlist import get_model_allowlist

router = APIRouter(tags=["models"])


@router.get("/v1/models", response_model=models.ModelList, operation_id="listModels")
async def list_models() -> models.ModelList:
    allowlist = get_model_allowlist()
    return models.ModelList(
        models=[
            models.ServedModel(id=model_id, tasks=allowlist.runs_tasks(model_id))
            for model_id in allowlist.targets
            if allowlist.available(model_id)
        ],
        defaultModel=allowlist.default_model,
        auto=allowlist.auto_available(),
    )


__all__ = ["router"]
