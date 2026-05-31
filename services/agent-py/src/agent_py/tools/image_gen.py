"""`generateImage` tool — Minimax T2I + I2I.

Phase 3d-1 of PLAN-agent-api. Narrow port of
`lib/server/skills/image-gen.ts` shipping the text-to-image (T2I) and
image-to-image (I2I, via `subject_reference`) paths via Minimax's
`/v1/image_generation` endpoint.

Differences from the TS port (documented for posterity):

  - **Persistence is deferred** to Phase 3d-2. For now the tool
    returns the temporary Minimax URLs inline, just like the TS path
    did when it first shipped (TS PR B + C layered persistence on
    later). Minimax URLs are typically valid for a few hours — enough
    for the current turn — and Phase 3d-2 will swap in Supabase
    Storage signed URLs without changing the tool's interface.
  - **Per-IP cross-turn rate limit** is not ported. The TS path
    plumbs an IP-bucket consumer; the Python service doesn't see the
    HTTP origin (it runs in the background after the chat route
    enqueues the task), so a per-IP bucket isn't meaningful here.
  - **Per-turn soft cap** (`maxCalls`) ports as a closure-held
    counter on a per-build basis. The Anthropic SDK doesn't expose
    per-step tool-call counts cleanly, so the count lives on the
    descriptor itself (each invocation increments before checking
    the cap). When the cap hits, the tool returns a structured error
    the model can recover from by stopping.
  - **SSRF gate** on `referenceImageUrl` is a narrow textual port:
    scheme check (`https://` only) + hostname blocklist (`.local`,
    `.internal`, `localhost`, etc.). The full DNS-resolution +
    private-IP-range check from `lib/server/url/validate.ts` lands
    when that helper itself ports (Phase 3+); until then the textual
    blocklist catches the obvious cases. The reference URL is also
    capped at 2000 chars to defend against pathological inputs.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import urlparse

import structlog

from ..settings import get_settings
from .minimax_image_client import minimax_generate_image
from .registry import ToolDescriptor, ToolError, ToolInvocationResult

logger = structlog.get_logger(__name__)


# Aspect ratios we surface to the model. Subset chosen from what
# Minimax's `aspect_ratio` parameter accepts. Mirrors
# `lib/shared/skills/image-gen-config.ts`.
IMAGE_GEN_ASPECT_RATIOS: tuple[str, ...] = (
    "1:1",
    "16:9",
    "9:16",
    "4:3",
    "3:4",
    "2:3",
    "3:2",
)
DEFAULT_ASPECT_RATIO = "1:1"

# Per-call cap: how many images one `generateImage` invocation can
# render. Matches Minimax's per-call upper bound + the TS-side
# `MAX_IMAGES_PER_CALL`. Independent from the per-turn cap.
MAX_IMAGES_PER_CALL = 4

# Default per-turn cap. The TS path lets workspaces / conversations
# override; the Python tool reads this constant for now (Phase 3+
# wires in per-run config).
DEFAULT_MAX_CALLS_PER_TURN = 2

# Defensive caps on user-supplied strings.
MAX_PROMPT_CHARS = 2000
MAX_REFERENCE_URL_CHARS = 2000


# Textual SSRF blocklist. Substring-match against the parsed
# lowercased hostname covers the obvious internal-DNS cases. Full
# DNS-resolution-based protection ports alongside `validate.ts` in
# a later phase.
_BLOCKED_HOST_EXACT: frozenset[str] = frozenset(
    {
        "localhost",
        "metadata.google.internal",
        "metadata.azure.com",
    }
)
_BLOCKED_HOST_SUFFIXES: tuple[str, ...] = (
    ".local",
    ".internal",
    ".localhost",
    ".lan",
    ".intranet",
    ".corp",
    ".home",
    ".svc.cluster.local",
)


def is_image_gen_configured() -> bool:
    """True when the server has a Minimax API key. Mirrors the TS
    `isImageGenConfigured()`."""
    return bool(get_settings().MINIMAX_CN_API_KEY.strip())


def _validate_reference_url(raw: str) -> str | None:
    """Return an error message when `raw` is unsafe to pass to
    Minimax, or None when it looks OK. Textual checks only — no
    DNS / IP range check yet."""
    if len(raw) > MAX_REFERENCE_URL_CHARS:
        return "referenceImageUrl too long"
    try:
        parsed = urlparse(raw)
    except ValueError:
        return "referenceImageUrl is not a valid URL"
    scheme = (parsed.scheme or "").lower()
    if scheme != "https":
        return "referenceImageUrl must use https://"
    hostname = (parsed.hostname or "").lower()
    if not hostname:
        return "referenceImageUrl has no hostname"
    if hostname in _BLOCKED_HOST_EXACT:
        return f"referenceImageUrl hostname {hostname!r} is blocked"
    if any(hostname.endswith(s) for s in _BLOCKED_HOST_SUFFIXES):
        return f"referenceImageUrl hostname {hostname!r} resolves to a private network"
    return None


def _build_text(prompt: str, mode: str, urls: list[str]) -> str:
    """The model-facing tool result. One numbered line per URL so the
    model can cite them; the URLs themselves render inline in the
    user's UI via the Sources / generated-images rail."""
    header = f"Generated {len(urls)} image{'s' if len(urls) != 1 else ''} ({mode}) for {prompt!r}:"
    lines = [header, ""]
    for i, url in enumerate(urls, start=1):
        lines.append(f"[{i}] {url}")
    return "\n".join(lines)


IMAGE_GEN_INPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "prompt": {
            "type": "string",
            "minLength": 1,
            "maxLength": MAX_PROMPT_CHARS,
            "description": (
                "A vivid, specific description of the image to generate. "
                "More detail produces better results — include style, "
                "composition, lighting, mood."
            ),
        },
        "aspectRatio": {
            "type": "string",
            "enum": list(IMAGE_GEN_ASPECT_RATIOS),
            "description": (
                f"Aspect ratio. Defaults to {DEFAULT_ASPECT_RATIO}. "
                "Pick from: " + ", ".join(IMAGE_GEN_ASPECT_RATIOS) + "."
            ),
        },
        "count": {
            "type": "integer",
            "minimum": 1,
            "maximum": MAX_IMAGES_PER_CALL,
            "description": (
                f"How many images to generate (1..{MAX_IMAGES_PER_CALL}). "
                "Defaults to 1. Higher counts cost proportionally more."
            ),
        },
        "referenceImageUrl": {
            "type": "string",
            "maxLength": MAX_REFERENCE_URL_CHARS,
            "description": (
                "Optional public https URL of a reference image. When "
                "provided, switches to image-to-image mode (Minimax "
                "treats the referenced image as a subject to render in "
                "the new scene). Must be a public web URL — internal "
                "and private addresses are rejected."
            ),
        },
    },
    "required": ["prompt"],
    "additionalProperties": False,
}


def build_image_gen_tool(
    *,
    max_calls_per_turn: int = DEFAULT_MAX_CALLS_PER_TURN,
) -> ToolDescriptor:
    """Construct the `generateImage` descriptor. The returned tool
    owns a closure-held counter so the per-turn cap is enforced across
    multiple invocations within one agent run (or within one chunk
    when chunked).

    The factory reads settings lazily on each call so a key flip in
    test fixtures or a runtime reload is picked up. Production runs
    set the env var once at startup."""

    # Per-turn counter — incremented inside `execute` so a re-build
    # of the descriptor resets the count (one descriptor per agent
    # run / chunk). The TS path uses the same closure pattern.
    call_log: list[bool] = []
    cap = max(1, max_calls_per_turn)

    async def execute(args: dict[str, Any]) -> ToolInvocationResult:
        prompt = args.get("prompt")
        if not isinstance(prompt, str) or not prompt.strip():
            raise ToolError("generateImage: missing or empty `prompt`.")
        prompt = prompt.strip()
        if len(prompt) > MAX_PROMPT_CHARS:
            raise ToolError(f"generateImage: `prompt` exceeds {MAX_PROMPT_CHARS} characters.")

        aspect_ratio_raw = args.get("aspectRatio")
        aspect_ratio = (
            aspect_ratio_raw
            if isinstance(aspect_ratio_raw, str) and aspect_ratio_raw in IMAGE_GEN_ASPECT_RATIOS
            else DEFAULT_ASPECT_RATIO
        )

        count_raw = args.get("count")
        if isinstance(count_raw, int) and 1 <= count_raw <= MAX_IMAGES_PER_CALL:
            count = count_raw
        else:
            count = 1

        reference_image_url_raw = args.get("referenceImageUrl")
        reference_image_url: str | None = None
        if isinstance(reference_image_url_raw, str) and reference_image_url_raw.strip():
            candidate = reference_image_url_raw.strip()
            err = _validate_reference_url(candidate)
            if err:
                raise ToolError(f"generateImage: {err}.")
            reference_image_url = candidate

        mode = "i2i" if reference_image_url else "t2i"

        # Per-turn cap — counted before the upstream call so a refused
        # call doesn't consume budget. Mirrors the TS path's
        # `log.length >= cap` check.
        if len(call_log) >= cap:
            raise ToolError(
                f"generateImage: per-turn budget exhausted "
                f"({cap} call{'s' if cap != 1 else ''} per turn). "
                "Answer with the images already produced or ask the user to refine."
            )
        call_log.append(True)

        settings = get_settings()
        api_key = settings.MINIMAX_CN_API_KEY.strip()
        base_url = settings.MINIMAX_CN_BASE_URL.strip() or None

        result = await minimax_generate_image(
            api_key=api_key,
            prompt=prompt,
            aspect_ratio=aspect_ratio,
            count=count,
            reference_image_url=reference_image_url,
            base_url_override=base_url,
        )

        if not result.ok:
            logger.warning(
                "image_gen.upstream_failed",
                code=result.code,
                mode=mode,
                prompt_len=len(prompt),
            )
            # Surface the upstream code so the model can decide whether
            # to retry, switch prompt, or stop. Auth / rate_limit /
            # content_policy / validation / upstream / network are the
            # stable codes.
            raise ToolError(f"generateImage [{result.code}]: {result.message}")

        urls = [img.url for img in result.images]
        text = _build_text(prompt, mode, urls)
        summary = f"{len(urls)} image{'s' if len(urls) != 1 else ''} ({mode})"
        return ToolInvocationResult(text=text, summary=summary)

    return ToolDescriptor(
        name="generateImage",
        description=(
            "Generate one or more images via Minimax (text-to-image, or "
            "image-to-image when you provide `referenceImageUrl`). Returns "
            "image URLs that render inline above your message. "
            f"HARD LIMIT: {cap} call{'s' if cap != 1 else ''} per turn. "
            f"Each call can render up to {MAX_IMAGES_PER_CALL} images. "
            "Use only when the user explicitly asks for an image; do not "
            "preemptively generate to illustrate text answers."
        ),
        input_schema=IMAGE_GEN_INPUT_SCHEMA,
        execute=execute,
    )


__all__ = [
    "DEFAULT_ASPECT_RATIO",
    "DEFAULT_MAX_CALLS_PER_TURN",
    "IMAGE_GEN_ASPECT_RATIOS",
    "IMAGE_GEN_INPUT_SCHEMA",
    "MAX_IMAGES_PER_CALL",
    "MAX_PROMPT_CHARS",
    "MAX_REFERENCE_URL_CHARS",
    "build_image_gen_tool",
    "is_image_gen_configured",
]
