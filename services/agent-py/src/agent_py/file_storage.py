"""A code run's files in and out of Supabase Storage (wave 8, Q92).

* **Output files** (`/tmp/outputs/*`): `persist_generated_file` is Next's
  `lib/server/file-storage.ts` per file — uploaded to
  `user-files/<user_id>/generated/<id>-<safe name>` with a 1-year signed URL
  when there is a user, Storage is configured and `localFilesOnly` is off;
  otherwise, or when the upload / sign fails, a `data:` URL.
* **Charts**: `persist_image_bytes` stores the bytes as `image_storage` stores
  a generated image (`<id>.<png|svg>`), with the same fallback.
* **Mounting a cloud file** (`sandboxFiles`, by id, Q44): the caller's
  `files` row read under RLS **and** checked on `user_id`, its
  `storage_path` inside the caller's folder, then downloaded with the
  service key (which bypasses RLS — hence the checks). Anything else reads
  as None, which the mount resolver turns into "could not be loaded": a
  file's existence never leaks.

Storage is reached over its REST API with the service-role key, as in
`image_storage` (no user session in a worker)."""

from __future__ import annotations

import base64
import re
from dataclasses import dataclass, field

import httpx
import structlog

from . import store
from .image_storage import (
    STORAGE_BUCKET,
    UPLOAD_TIMEOUT_S,
    DownloadedImage,
    PersistedImage,
    _upload_and_sign,
    inline_image,
    is_storage_configured,
)
from .settings import get_settings
from .tools.registry import ToolContext

logger = structlog.get_logger(__name__)

SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 365
DOWNLOAD_TIMEOUT_S = 30.0
_UUID = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
_IMAGE_MIME = {"png": "image/png", "svg": "image/svg+xml"}


@dataclass(frozen=True)
class FileToPersist:
    id: str
    """`<toolCallId>-file-<i>`: the object-name prefix and the part's id."""
    name: str
    mime_type: str
    data: bytes = field(repr=False)


@dataclass(frozen=True)
class PersistedFile:
    id: str
    name: str
    mime_type: str
    size_bytes: int
    url: str = field(repr=False)
    """A signed Storage URL or a `data:` URL."""
    storage_path: str | None = None


def _safe_name(name: str) -> str:
    """`safeName`: the last path segment, `[A-Za-z0-9._-]` only."""
    base = re.split(r"[\\/]", name)[-1]
    return re.sub(r"[^A-Za-z0-9._-]", "_", base) or "file"


def _auth() -> dict[str, str]:
    key = get_settings().SUPABASE_SERVICE_ROLE_KEY.strip()
    return {"Authorization": f"Bearer {key}", "apikey": key}


def _base() -> str:
    return get_settings().SUPABASE_URL.rstrip("/")


async def _upload(
    path: str, data: bytes, mime: str, client: httpx.AsyncClient
) -> tuple[str, str] | None:
    """Upload + sign; (path, signed URL) or None on any failure."""
    try:
        up = await client.post(
            f"{_base()}/storage/v1/object/{STORAGE_BUCKET}/{path}",
            content=data,
            headers={**_auth(), "Content-Type": mime, "x-upsert": "true"},
            timeout=UPLOAD_TIMEOUT_S,
        )
        if up.status_code >= 400:
            return None
        sg = await client.post(
            f"{_base()}/storage/v1/object/sign/{STORAGE_BUCKET}/{path}",
            json={"expiresIn": SIGNED_URL_TTL_SECONDS},
            headers=_auth(),
            timeout=UPLOAD_TIMEOUT_S,
        )
        if sg.status_code >= 400:
            return None
        signed = sg.json().get("signedURL")
    except (httpx.HTTPError, ValueError, AttributeError):
        return None
    if not isinstance(signed, str) or not signed:
        return None
    return path, f"{_base()}/storage/v1{signed}" if signed.startswith("/") else signed


async def persist_generated_file(
    file: FileToPersist,
    *,
    user_id: str | None,
    local_files_only: bool = False,
    client: httpx.AsyncClient | None = None,
) -> PersistedFile:
    """Never raises: the data URL is the fallback for every failure."""
    stored: tuple[str, str] | None = None
    if user_id and not local_files_only and is_storage_configured():
        path = f"{user_id}/generated/{file.id}-{_safe_name(file.name)}"
        own = client is None
        http = client or httpx.AsyncClient(timeout=UPLOAD_TIMEOUT_S)
        try:
            stored = await _upload(path, file.data, file.mime_type, http)
        finally:
            if own:
                await http.aclose()
        if stored is None:
            logger.warning("file_storage.upload_failed_inlining", file_id=file.id)
    if stored is not None:
        path, url = stored
        return PersistedFile(file.id, file.name, file.mime_type, len(file.data), url, path)
    encoded = base64.b64encode(file.data).decode("ascii")
    return PersistedFile(
        file.id,
        file.name,
        file.mime_type,
        len(file.data),
        f"data:{file.mime_type};base64,{encoded}",
    )


async def persist_image_bytes(
    data: bytes,
    *,
    fmt: str,
    user_id: str | None,
    image_id: str,
    local_files_only: bool = False,
    client: httpx.AsyncClient | None = None,
) -> PersistedImage:
    """A chart (`png` / `svg`) stored like a generated image; never raises."""
    image = DownloadedImage(body=data, mime=_IMAGE_MIME.get(fmt, "image/png"))
    if user_id and not local_files_only and is_storage_configured():
        uploaded = await _upload_and_sign(
            image, user_id=user_id, image_id=image_id, format_hint=fmt, client=client
        )
        if isinstance(uploaded, PersistedImage):
            return uploaded
        logger.warning("file_storage.chart_upload_failed_inlining", image_id=image_id)
    return inline_image(image, format_hint=fmt)


_FILE_ROW_SQL = """
SELECT user_id::text, storage_path
FROM public.files
WHERE id = $1::uuid AND user_id = $2::uuid AND deleted_at IS NULL
"""


async def download_user_file(
    context: ToolContext,
    file_id: str,
    *,
    max_bytes: int = 10_000_000,
    client: httpx.AsyncClient | None = None,
) -> bytes | None:
    """The caller's cloud file's bytes, or None. Reads at most `max_bytes`
    + 1 (enough for the mount check to call it too large)."""
    if not _UUID.match(file_id) or not is_storage_configured():
        return None
    try:
        async with context.pool.acquire() as conn, conn.transaction():
            await store._set_user_context(conn, user_id=context.user_id)
            rows = await conn.fetch(_FILE_ROW_SQL, file_id, context.user_id)
    except Exception as exc:
        logger.warning("file_storage.file_row_failed", error=str(exc))
        return None
    row = rows[0] if rows else None
    if row is None or str(row["user_id"]).lower() != context.user_id.lower():
        return None
    path = row["storage_path"]
    if not isinstance(path, str) or path.split("/", 1)[0].lower() != context.user_id.lower():
        return None
    own = client is None
    http = client or httpx.AsyncClient(timeout=DOWNLOAD_TIMEOUT_S)
    try:
        async with http.stream(
            "GET",
            f"{_base()}/storage/v1/object/{STORAGE_BUCKET}/{path}",
            headers=_auth(),
            timeout=DOWNLOAD_TIMEOUT_S,
        ) as response:
            if response.status_code >= 400:
                return None
            data = bytearray()
            async for chunk in response.aiter_bytes():
                data.extend(chunk)
                if len(data) > max_bytes:
                    return bytes(data[: max_bytes + 1])
            return bytes(data)
    except httpx.HTTPError as exc:
        logger.warning("file_storage.download_failed", error=str(exc))
        return None
    finally:
        if own:
            await http.aclose()
