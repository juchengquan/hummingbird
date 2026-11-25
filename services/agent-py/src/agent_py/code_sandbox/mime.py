"""An output file's MIME type by its extension (`mime.ts`): the sandbox is
airgapped, so the name is all there is. Unknown → octet-stream."""

from __future__ import annotations

_MIME_BY_EXT = {
    "csv": "text/csv",
    "json": "application/json",
    "txt": "text/plain",
    "md": "text/markdown",
    "html": "text/html",
    "pdf": "application/pdf",
    "zip": "application/zip",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "xls": "application/vnd.ms-excel",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "svg": "image/svg+xml",
    "parquet": "application/vnd.apache.parquet",
}


def mime_for_name(name: str) -> str:
    if "." not in name:
        return "application/octet-stream"
    ext = name.rsplit(".", 1)[1].lower()
    return _MIME_BY_EXT.get(ext, "application/octet-stream")
