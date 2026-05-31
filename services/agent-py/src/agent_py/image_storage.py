"""Persistence layer for `generateImage` tool output.

Phase 3d-2 of PLAN-agent-api. Narrow port of
`lib/server/image-storage.ts`.

Minimax returns short-lived hosted URLs (typically valid for a few
hours). To survive a tab reload — or just a chat left open overnight
— we download each image once, upload to Supabase Storage under
`user-files/<user_id>/generated/<image_id>.<ext>`, and mint a long-
lived signed URL the model returns to the user.

Differences from the TS port:

  - **Auth path.** The TS path runs under the user's Supabase session
    cookie; RLS on `storage.objects` gates each upload by
    `(storage.foldername(name))[1] = auth.uid()`. The Python service
    talks to Supabase Storage's REST API directly using the
    service-role key, which bypasses RLS — same security outcome
    because the executor's `payload.user_id` came from a verified JWT
    on the chat-route side and we stamp it into the path ourselves.
    There's no equivalent of cookie auth available to a background
    worker.

  - **Anonymous fallback.** The TS path drops to a `data:` URL when
    no Supabase session is available. The Python path is symmetric:
    if `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` aren't configured
    OR the upload / sign call fails, the caller treats it as "no
    persistence" and surfaces the original Minimax URL inline. Phase
    3d-1's behaviour is the failure-mode floor.

  - **`localFilesOnly` opt-out.** Not ported — the Python service
    runs server-side per-user and doesn't see a "Store files locally"
    UI preference. If that preference matters in flight, the chat
    route should refuse to enqueue the `generateImage` request in
    the first place.

Per-image caps mirror the TS path:
  - Download timeout: 10 seconds.
  - Max raw bytes: 4 MB.
  - Signed URL TTL: 1 year.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

import httpx
import structlog

from .settings import get_settings

logger = structlog.get_logger(__name__)


DOWNLOAD_TIMEOUT_S = 10.0
UPLOAD_TIMEOUT_S = 30.0
MAX_BYTES_PER_IMAGE = 4 * 1024 * 1024
# 1-year signed URLs — matches the file-upload flow in
# `hooks/use-upload-file.ts`. UI can re-sign from `storage_path` when
# the URL ever expires (route ports as Phase 3d-3+).
SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 365
STORAGE_BUCKET = "user-files"


@dataclass(frozen=True)
class PersistedImage:
    """Result of persisting one Minimax-hosted image. `storage_path`
    is set only when the cloud upload succeeded; the UI uses it to
    re-sign the URL if the original ever expires."""

    url: str
    storage_path: str | None = None
    format: str = "png"


@dataclass(frozen=True)
class PersistError:
    ok: Literal[False] = False
    code: Literal["download", "upload", "sign", "too_large", "config"] = "upload"
    message: str = ""


PersistResult = PersistedImage | PersistError


def is_storage_configured() -> bool:
    """True when both SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set,
    so we can reach the Storage REST API. The caller is expected to
    fall back to inline URLs when this returns False."""
    settings = get_settings()
    return bool(settings.SUPABASE_URL.strip()) and bool(settings.SUPABASE_SERVICE_ROLE_KEY.strip())


async def persist_generated_image(
    minimax_url: str,
    *,
    user_id: str,
    image_id: str,
    format_hint: str = "png",
    client: httpx.AsyncClient | None = None,
) -> PersistResult:
    """Download a Minimax-hosted image and mirror it into Supabase
    Storage; return the signed URL + storage path on success, or
    ``PersistError`` on any failure.

    The caller (the `generateImage` tool) catches ``PersistError`` and
    falls back to surfacing the original ``minimax_url`` so the model
    still has something to reference — the user-facing impact is "URL
    expires in a few hours instead of a year".

    `client` is a test seam — production paths let the function build
    its own short-lived `httpx.AsyncClient` for the upstream Minimax
    download.
    """
    if not is_storage_configured():
        return PersistError(code="config", message="Supabase Storage not configured")

    own_client = client is None
    if client is None:
        client = httpx.AsyncClient(timeout=DOWNLOAD_TIMEOUT_S)

    try:
        # 1. Pull bytes from Minimax.
        try:
            response = await client.get(minimax_url, follow_redirects=True)
        except httpx.HTTPError as exc:
            logger.warning(
                "image_storage.download_failed",
                url=minimax_url,
                error=str(exc),
            )
            return PersistError(code="download", message=str(exc))

        if response.status_code >= 400:
            return PersistError(
                code="download",
                message=f"Minimax image fetch HTTP {response.status_code}",
            )

        body = response.content
        if len(body) > MAX_BYTES_PER_IMAGE:
            return PersistError(
                code="too_large",
                message=f"image is {len(body)} bytes (cap {MAX_BYTES_PER_IMAGE})",
            )

        # Trust response Content-Type over the format hint — Minimax
        # says "png" everywhere but if they ever return JPEG the
        # persisted bytes shouldn't get a wrong extension.
        mime = (
            response.headers.get("content-type", "").split(";")[0].strip()
            or f"image/{format_hint or 'png'}"
        )
        ext = _mime_to_ext(mime, fallback=format_hint or "png")
        path = f"{user_id}/generated/{image_id}.{ext}"

        # 2. Upload to Supabase Storage. We use the service-role key
        #    so the path is the truth, not RLS — the user_id stamped
        #    into the path came from a verified JWT upstream.
        settings = get_settings()
        base = settings.SUPABASE_URL.rstrip("/")
        service_key = settings.SUPABASE_SERVICE_ROLE_KEY.strip()
        headers = {
            "Authorization": f"Bearer {service_key}",
            "apikey": service_key,
            "Content-Type": mime,
            # Upsert so a retried image_id (same call, same index)
            # overwrites cleanly instead of erroring.
            "x-upsert": "true",
        }
        upload_url = f"{base}/storage/v1/object/{STORAGE_BUCKET}/{path}"
        try:
            up = await client.post(
                upload_url,
                content=body,
                headers=headers,
                timeout=UPLOAD_TIMEOUT_S,
            )
        except httpx.HTTPError as exc:
            logger.warning(
                "image_storage.upload_failed",
                path=path,
                error=str(exc),
            )
            return PersistError(code="upload", message=str(exc))

        if up.status_code >= 400:
            return PersistError(
                code="upload",
                message=f"Storage upload HTTP {up.status_code}: {up.text[:200]}",
            )

        # 3. Mint a long-lived signed URL.
        sign_url = f"{base}/storage/v1/object/sign/{STORAGE_BUCKET}/{path}"
        try:
            sg = await client.post(
                sign_url,
                json={"expiresIn": SIGNED_URL_TTL_SECONDS},
                headers={
                    "Authorization": f"Bearer {service_key}",
                    "apikey": service_key,
                },
                timeout=UPLOAD_TIMEOUT_S,
            )
        except httpx.HTTPError as exc:
            logger.warning(
                "image_storage.sign_failed",
                path=path,
                error=str(exc),
            )
            return PersistError(code="sign", message=str(exc))

        if sg.status_code >= 400:
            return PersistError(
                code="sign",
                message=f"Sign URL HTTP {sg.status_code}: {sg.text[:200]}",
            )

        try:
            payload = sg.json()
        except Exception as exc:
            return PersistError(code="sign", message=f"sign response not JSON: {exc}")

        # Supabase returns `{signedURL: "/object/sign/<bucket>/<path>?token=..."}` —
        # a relative URL we have to prefix with the project origin.
        signed = payload.get("signedURL") if isinstance(payload, dict) else None
        if not isinstance(signed, str) or not signed:
            return PersistError(code="sign", message="sign response missing signedURL")
        if signed.startswith("/"):
            signed = f"{base}/storage/v1{signed}"

        return PersistedImage(url=signed, storage_path=path, format=ext)

    finally:
        if own_client:
            await client.aclose()


def _mime_to_ext(mime: str, *, fallback: str) -> str:
    """Map an `image/foo` content-type to its file extension, with
    `jpeg`→`jpg` normalisation matching the TS helper."""
    sub = mime.split("/")[-1].lower() if "/" in mime else ""
    if not sub:
        return fallback or "png"
    if sub == "jpeg":
        return "jpg"
    return sub


__all__ = [
    "DOWNLOAD_TIMEOUT_S",
    "MAX_BYTES_PER_IMAGE",
    "SIGNED_URL_TTL_SECONDS",
    "STORAGE_BUCKET",
    "PersistError",
    "PersistResult",
    "PersistedImage",
    "is_storage_configured",
    "persist_generated_image",
]
