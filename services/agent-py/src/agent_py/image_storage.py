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

  - **Data-URL fallback (interactive runs).** `persist_or_inline_image`
    is the TS `persistGeneratedImages` per image: download once, then
    upload to Storage when there is a user, Storage is configured and
    `localFilesOnly` is off; otherwise — or when the upload / sign
    fails — return `data:<mime>;base64,…` so the image survives the
    Minimax URL's expiry. Anonymous runs and `localFilesOnly` runs
    always get data URLs. A failed *download* is a `PersistError`; the
    caller keeps the Minimax URL then (TS drops that image).

  - **Background runs** use the same `persist_or_inline_image` when there
    is a user and Storage is configured (wave 7): a failed upload is kept
    as a data URL, not Minimax's URL, which dies in hours. With no Storage
    configured they surface the Minimax URL. `localFilesOnly` background
    runs take the runs path (wave 6, Q71). A data URL reaches the task's
    log and its result; a `listRuns` row leaves `result.images` out.

Per-image caps mirror the TS path:
  - Download timeout: 10 seconds.
  - Max raw bytes: 4 MB.
  - Signed URL TTL: 1 year.
"""

from __future__ import annotations

import base64
from dataclasses import dataclass
from typing import Literal
from urllib.parse import quote

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


@dataclass(frozen=True)
class DownloadedImage:
    body: bytes
    mime: str


async def download_image(
    url: str, *, format_hint: str = "png", client: httpx.AsyncClient | None = None
) -> DownloadedImage | PersistError:
    """GET a Minimax-hosted image (10 s, 4 MB cap). The MIME type is the
    response's `Content-Type`, else `image/<format_hint>`."""
    own_client = client is None
    if client is None:
        client = httpx.AsyncClient(timeout=DOWNLOAD_TIMEOUT_S)
    try:
        try:
            response = await client.get(url, follow_redirects=True)
        except httpx.HTTPError as exc:
            logger.warning("image_storage.download_failed", url=url, error=str(exc))
            return PersistError(code="download", message=str(exc))
        if response.status_code >= 400:
            return PersistError(
                code="download", message=f"Minimax image fetch HTTP {response.status_code}"
            )
        body = response.content
        if len(body) > MAX_BYTES_PER_IMAGE:
            return PersistError(
                code="too_large",
                message=f"image is {len(body)} bytes (cap {MAX_BYTES_PER_IMAGE})",
            )
        mime = (
            response.headers.get("content-type", "").split(";")[0].strip()
            or f"image/{format_hint or 'png'}"
        )
        return DownloadedImage(body=body, mime=mime)
    finally:
        if own_client:
            await client.aclose()


def inline_image(image: DownloadedImage, *, format_hint: str = "png") -> PersistedImage:
    """The TS data-URL fallback: `data:<mime>;base64,<bytes>`."""
    encoded = base64.b64encode(image.body).decode("ascii")
    return PersistedImage(
        url=f"data:{image.mime};base64,{encoded}",
        format=_mime_to_ext(image.mime, fallback=format_hint or "png"),
    )


async def persist_or_inline_image(
    minimax_url: str,
    *,
    user_id: str | None,
    image_id: str,
    local_files_only: bool = False,
    format_hint: str = "png",
    client: httpx.AsyncClient | None = None,
) -> PersistResult:
    """Interactive runs' persistence (TS `persistGeneratedImages`, one
    image): download, then a Storage signed URL when `user_id` is set,
    Storage is configured and `local_files_only` is off — else, or when
    the upload / sign fails, a data URL. `PersistError` only when the
    download itself fails."""
    downloaded = await download_image(minimax_url, format_hint=format_hint, client=client)
    if isinstance(downloaded, PersistError):
        return downloaded
    if user_id and not local_files_only and is_storage_configured():
        uploaded = await _upload_and_sign(
            downloaded, user_id=user_id, image_id=image_id, format_hint=format_hint, client=client
        )
        if isinstance(uploaded, PersistedImage):
            return uploaded
        logger.warning(
            "image_storage.upload_failed_inlining",
            image_id=image_id,
            code=uploaded.code,
            error=uploaded.message,
        )
    return inline_image(downloaded, format_hint=format_hint)


async def _upload_and_sign(
    image: DownloadedImage,
    *,
    user_id: str,
    image_id: str,
    format_hint: str,
    client: httpx.AsyncClient | None,
) -> PersistResult:
    """Upload downloaded bytes to `user-files/<user_id>/generated/` and
    mint the 1-year signed URL (the second half of
    `persist_generated_image`)."""
    settings = get_settings()
    base = settings.SUPABASE_URL.rstrip("/")
    service_key = settings.SUPABASE_SERVICE_ROLE_KEY.strip()
    ext = _mime_to_ext(image.mime, fallback=format_hint or "png")
    path = f"{user_id}/generated/{image_id}.{ext}"
    auth = {"Authorization": f"Bearer {service_key}", "apikey": service_key}
    own_client = client is None
    if client is None:
        client = httpx.AsyncClient(timeout=UPLOAD_TIMEOUT_S)
    try:
        try:
            up = await client.post(
                f"{base}/storage/v1/object/{STORAGE_BUCKET}/{path}",
                content=image.body,
                headers={**auth, "Content-Type": image.mime, "x-upsert": "true"},
                timeout=UPLOAD_TIMEOUT_S,
            )
        except httpx.HTTPError as exc:
            return PersistError(code="upload", message=str(exc))
        if up.status_code >= 400:
            return PersistError(code="upload", message=f"Storage upload HTTP {up.status_code}")
        try:
            sg = await client.post(
                f"{base}/storage/v1/object/sign/{STORAGE_BUCKET}/{path}",
                json={"expiresIn": SIGNED_URL_TTL_SECONDS},
                headers=auth,
                timeout=UPLOAD_TIMEOUT_S,
            )
        except httpx.HTTPError as exc:
            return PersistError(code="sign", message=str(exc))
        if sg.status_code >= 400:
            return PersistError(code="sign", message=f"Sign URL HTTP {sg.status_code}")
        try:
            payload = sg.json()
        except Exception as exc:
            return PersistError(code="sign", message=f"sign response not JSON: {exc}")
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


async def sign_storage_path(
    storage_path: str,
    *,
    client: httpx.AsyncClient | None = None,
) -> str | None:
    """Mint a fresh signed URL for an already-uploaded object at
    `storage_path` in the `user-files` bucket. Used by Phase 4-4-a's
    `/v1/images/refresh-url` route — a year-old chat hits an expired
    signed URL; the bytes are still in Storage at the same path, we
    just need a new signature.

    Returns the signed URL on success or ``None`` when:
      - Storage isn't configured (missing `SUPABASE_URL` /
        `SUPABASE_SERVICE_ROLE_KEY`),
      - the object doesn't exist (sign returns 404),
      - the sign call fails (network, malformed response, etc.).

    The caller is responsible for the auth check; this helper only
    mints the URL. Mirrors the TS `signGeneratedImageUrl` shape."""
    if not is_storage_configured():
        return None

    settings = get_settings()
    base = settings.SUPABASE_URL.rstrip("/")
    service_key = settings.SUPABASE_SERVICE_ROLE_KEY.strip()

    own_client = client is None
    if client is None:
        client = httpx.AsyncClient(timeout=UPLOAD_TIMEOUT_S)
    try:
        # Percent-encode the caller-supplied path (keeping `/`) so `?`, `#`
        # or an encoded `%2E%2E` can't reshape the Storage request: the
        # service-role key bypasses RLS, so the routes' first-segment
        # check must see the same path Storage signs. A no-op for the
        # paths this service and the Next.js app write
        # (`<uid>/generated/<id>[-name].<ext>`, `[A-Za-z0-9._-]` only).
        encoded = quote(storage_path, safe="/")
        sign_url = f"{base}/storage/v1/object/sign/{STORAGE_BUCKET}/{encoded}"
        try:
            response = await client.post(
                sign_url,
                json={"expiresIn": SIGNED_URL_TTL_SECONDS},
                headers={
                    "Authorization": f"Bearer {service_key}",
                    "apikey": service_key,
                },
            )
        except httpx.HTTPError as exc:
            logger.warning(
                "image_storage.sign_failed",
                path=storage_path,
                error=str(exc),
            )
            return None
        if response.status_code >= 400:
            logger.info(
                "image_storage.sign_http_error",
                path=storage_path,
                status=response.status_code,
            )
            return None
        try:
            payload = response.json()
        except Exception:
            return None
        signed = payload.get("signedURL") if isinstance(payload, dict) else None
        if not isinstance(signed, str) or not signed:
            return None
        if signed.startswith("/"):
            signed = f"{base}/storage/v1{signed}"
        return signed
    finally:
        if own_client:
            await client.aclose()


__all__ = [
    "DOWNLOAD_TIMEOUT_S",
    "MAX_BYTES_PER_IMAGE",
    "SIGNED_URL_TTL_SECONDS",
    "STORAGE_BUCKET",
    "DownloadedImage",
    "PersistError",
    "PersistResult",
    "PersistedImage",
    "download_image",
    "inline_image",
    "is_storage_configured",
    "persist_generated_image",
    "persist_or_inline_image",
    "sign_storage_path",
]
