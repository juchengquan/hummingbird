"""Low-level Minimax image-generation client.

Phase 3d-1 of PLAN-agent-api. Narrow port of
`lib/server/skills/minimax-image-client.ts`. Wraps the documented
endpoint:

    POST <baseURL>/v1/image_generation
    Authorization: Bearer <MINIMAX_CN_API_KEY>
    Content-Type: application/json

    body = {
        model: "image-01",
        prompt: "...",
        aspect_ratio: "16:9",
        response_format: "url",
        n: 1..4,
        prompt_optimizer: true,
        # I2I mode (when referenceImageUrl is provided):
        subject_reference: [{type: "character", image_file: "https://..."}],
    }

The auth key is shared with the Minimax-CN chat bypass — Minimax
issues one key per account that covers both APIs. The endpoint URL
is region-specific (Minimax keys are tied to a region) and is
resolved at call time via `get_image_endpoint`:

  1. Derive from `MINIMAX_CN_BASE_URL`'s origin + `/v1/image_generation`.
     Chat and image share a host but live under different paths, so
     we strip the chat-specific path (e.g. `/anthropic/v1`) and use
     the host root.
  2. Otherwise (`MINIMAX_CN_BASE_URL` unset), fall back to the
     endpoint `https://api.minimaxi.com/v1/image_generation`.

Failure handling is structured: every error returns
`MinimaxImageError(code, message)` with one of a small set of stable
codes the caller can map to user-facing copy. Network errors,
timeouts, HTTP status codes, and Minimax's own `base_resp.status_code`
convention all funnel through `map_minimax_status_code` so the surface
stays small.

Per-call timeout: 30 seconds. Image generation is slower than text;
30s is enough headroom for a typical T2I roundtrip without leaving
the chat turn frozen if Minimax stalls.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal
from urllib.parse import urlparse

import httpx

DEFAULT_ENDPOINT = "https://api.minimaxi.com/v1/image_generation"
MODEL = "image-01"
CALL_TIMEOUT_S = 30.0


MinimaxErrorCode = Literal[
    "auth",
    "rate_limit",
    "content_policy",
    "validation",
    "upstream",
    "network",
]


@dataclass(frozen=True)
class MinimaxImage:
    """One image returned by Minimax. Width/height are 0 when the
    response didn't include explicit dimensions (the UI infers them
    from the loaded image)."""

    url: str
    width: int = 0
    height: int = 0
    format: str = "png"


@dataclass(frozen=True)
class MinimaxImageSuccess:
    ok: Literal[True] = True
    images: list[MinimaxImage] = None  # type: ignore[assignment]


@dataclass(frozen=True)
class MinimaxImageError:
    ok: Literal[False] = False
    code: MinimaxErrorCode = "upstream"
    message: str = ""


MinimaxImageResult = MinimaxImageSuccess | MinimaxImageError


def get_image_endpoint(*, base_url_override: str | None = None) -> str:
    """Resolve the image-generation endpoint. When
    `MINIMAX_CN_BASE_URL` is set, the image endpoint lives on the same
    host as the chat-bypass (just under a different path), so we strip
    the chat-specific path and rebuild against the host root. Otherwise
    fall back to the international endpoint. Invalid URLs fall through
    silently — the request will hit the next layer's validation
    (likely the network) and surface the failure there rather than
    throwing at config time.

    `base_url_override` is a test seam — the executor always reads it
    from settings."""
    raw = (base_url_override or "").strip()
    if raw:
        try:
            parsed = urlparse(raw)
            if parsed.scheme and parsed.netloc:
                return f"{parsed.scheme}://{parsed.netloc}/v1/image_generation"
        except Exception:
            pass
    return DEFAULT_ENDPOINT


async def minimax_generate_image(
    *,
    api_key: str,
    prompt: str,
    aspect_ratio: str,
    count: int,
    reference_image_url: str | None = None,
    base_url_override: str | None = None,
    client: httpx.AsyncClient | None = None,
) -> MinimaxImageResult:
    """POST to Minimax `/v1/image_generation` and parse the response.

    `client` is a test seam — production callers let the function build
    its own `httpx.AsyncClient` with the per-call timeout. Tests pass a
    pre-built client backed by `httpx.MockTransport` so they stay
    hermetic."""
    if not api_key:
        return MinimaxImageError(code="auth", message="MINIMAX_CN_API_KEY is not set")

    body: dict[str, Any] = {
        "model": MODEL,
        "prompt": prompt,
        "aspect_ratio": aspect_ratio,
        "response_format": "url",
        "n": count,
        "prompt_optimizer": True,
    }
    if reference_image_url:
        body["subject_reference"] = [{"type": "character", "image_file": reference_image_url}]

    endpoint = get_image_endpoint(base_url_override=base_url_override)
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    own_client = client is None
    if client is None:
        client = httpx.AsyncClient(timeout=CALL_TIMEOUT_S)

    try:
        try:
            response = await client.post(endpoint, json=body, headers=headers)
        except httpx.TimeoutException:
            return MinimaxImageError(
                code="network",
                message=f"Image generation timed out after {CALL_TIMEOUT_S}s",
            )
        except httpx.HTTPError as exc:
            return MinimaxImageError(code="network", message=str(exc))

        if response.status_code in (401, 403):
            return MinimaxImageError(
                code="auth",
                message="Minimax rejected the API key",
            )
        if response.status_code == 429:
            return MinimaxImageError(
                code="rate_limit",
                message="Minimax rate-limited the request — back off and retry",
            )
        if response.status_code >= 400:
            return MinimaxImageError(
                code="upstream",
                message=f"Minimax returned HTTP {response.status_code}",
            )

        try:
            json_body = response.json()
        except Exception as exc:
            return MinimaxImageError(
                code="upstream",
                message=f"Minimax response was not valid JSON: {exc}",
            )

        base_resp = json_body.get("base_resp") if isinstance(json_body, dict) else None
        if isinstance(base_resp, dict):
            status_code = base_resp.get("status_code")
            if isinstance(status_code, int) and status_code != 0:
                code = map_minimax_status_code(status_code)
                msg = base_resp.get("status_msg")
                return MinimaxImageError(
                    code=code,
                    message=(
                        msg if isinstance(msg, str) else f"Minimax error {status_code} (no message)"
                    ),
                )

        urls = extract_image_urls(json_body if isinstance(json_body, dict) else {})
        if not urls:
            return MinimaxImageError(
                code="upstream",
                message="Minimax returned no image URLs",
            )
        return MinimaxImageSuccess(images=[MinimaxImage(url=u) for u in urls])

    finally:
        if own_client:
            await client.aclose()


def map_minimax_status_code(code: int) -> MinimaxErrorCode:
    """Map Minimax's documented `base_resp.status_code` to a stable
    user-facing code. The list starts small; expand whenever production
    logs surface an unmapped code. Unknown codes fall through to
    ``upstream`` which surfaces the original ``status_msg`` to the
    model."""
    if code in (1004, 1008):
        return "auth"
    if code in (1013, 1039):
        return "rate_limit"
    if code in (2013, 2049):
        return "content_policy"
    if code in (1002, 2032):
        return "validation"
    return "upstream"


def extract_image_urls(json_body: dict[str, Any]) -> list[str]:
    """Pull image URLs out of the Minimax response. The documented
    shape is ``data.image_urls: list[str]``; we also accept
    ``data.images[].url`` and ``data.images[].image_url`` because
    Minimax has shipped variants over time. Returns ``[]`` when nothing
    recognisable is present — the caller treats that as an upstream
    error."""
    data = json_body.get("data") if isinstance(json_body, dict) else None
    if not isinstance(data, dict):
        return []
    image_urls = data.get("image_urls")
    if isinstance(image_urls, list):
        return [u for u in image_urls if isinstance(u, str)]
    images = data.get("images")
    if isinstance(images, list):
        out: list[str] = []
        for img in images:
            if not isinstance(img, dict):
                continue
            u = img.get("url") or img.get("image_url")
            if isinstance(u, str):
                out.append(u)
        return out
    return []


__all__ = [
    "CALL_TIMEOUT_S",
    "DEFAULT_ENDPOINT",
    "MODEL",
    "MinimaxImage",
    "MinimaxImageError",
    "MinimaxImageResult",
    "MinimaxImageSuccess",
    "extract_image_urls",
    "get_image_endpoint",
    "map_minimax_status_code",
    "minimax_generate_image",
]
