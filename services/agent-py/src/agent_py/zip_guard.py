"""Zip-bomb guard for OOXML uploads (docx via python-docx, xlsx via openpyxl).

Python port of `lib/server/extraction/zip-guard.ts`. Both parsers open
the archive with `zipfile` and inflate entries with no output cap, so a
5 MB upload could expand to gigabytes. This runs BEFORE the parser and:

  1. walks the central directory (the index `zipfile` itself reads —
     no entry is inflated) and fails fast on too many entries, an
     unsupported compression method, or too large a DECLARED total;
  2. then actually inflates each entry, a bounded chunk at a time, with
     the output capped at the remaining budget — declared sizes are
     attacker-controlled, so the real decompressed byte count is what's
     enforced.

Inflate work is bounded by the budget itself, so the guard can't be
turned into the DoS it prevents. Only stored (0) and deflate (8) entries
are accepted — the only methods python-docx / openpyxl meet in practice
(and the TS guard's rule).
"""

from __future__ import annotations

import io
import zipfile
import zlib

__all__ = [
    "ZIP_MAX_ENTRIES",
    "ZIP_MAX_TOTAL_UNCOMPRESSED",
    "ZipLimitError",
    "assert_zip_within_limits",
    "looks_like_zip",
]

# Same caps as the TS guard: a 5 MB upload at a generous ~20x XML
# compression ratio stays well under 100 MB; real docx / xlsx files have
# tens to a few hundred entries.
ZIP_MAX_ENTRIES = 5_000
ZIP_MAX_TOTAL_UNCOMPRESSED = 100 * 1024 * 1024

_READ_CHUNK = 64 * 1024
_LFH_SIG = b"PK\x03\x04"
_EOCD_SIG = b"PK\x05\x06"


class ZipLimitError(ValueError):
    """The archive is unreadable or exceeds an extraction limit. The
    extract route maps it to 413 (same as the TS route)."""


def looks_like_zip(data: bytes) -> bool:
    """True when `data` is (or claims to be) a zip archive: a local
    file header up front, or an end-of-central-directory record in the
    trailing 64 KiB + 22 bytes."""
    if data[:4] == _LFH_SIG:
        return True
    return _EOCD_SIG in data[-(0xFFFF + 22) :]


def assert_zip_within_limits(
    data: bytes,
    *,
    max_entries: int = ZIP_MAX_ENTRIES,
    max_total_uncompressed: int = ZIP_MAX_TOTAL_UNCOMPRESSED,
) -> None:
    """Raise `ZipLimitError` unless `data` is a zip whose entry count
    and real inflated size are within the limits."""
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except (zipfile.BadZipFile, zipfile.LargeZipFile, OSError, ValueError) as exc:
        raise ZipLimitError("Not a readable zip archive.") from exc

    with archive:
        infos = archive.infolist()
        if len(infos) > max_entries:
            raise ZipLimitError(f"Zip archive has too many entries ({len(infos)} > {max_entries}).")
        declared_total = 0
        for info in infos:
            if info.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                raise ZipLimitError(f"Unsupported zip compression method {info.compress_type}.")
            declared_total += info.file_size
            if declared_total > max_total_uncompressed:
                raise ZipLimitError(
                    f"Zip archive expands beyond the {max_total_uncompressed}-byte "
                    "extraction limit."
                )

        # Declared sizes can lie — enforce the real inflated size. Read
        # each entry's RAW (compressed) bytes and inflate them ourselves
        # with a capped output, so a lying header can't make `zipfile`
        # produce more than the remaining budget.
        actual_total = 0
        for info in infos:
            remaining = max_total_uncompressed - actual_total
            produced = _inflated_size(archive, info, cap=remaining)
            actual_total += produced
            if actual_total > max_total_uncompressed:
                raise ZipLimitError(
                    f"Zip archive expands beyond the {max_total_uncompressed}-byte "
                    "extraction limit."
                )


def _inflated_size(archive: zipfile.ZipFile, info: zipfile.ZipInfo, *, cap: int) -> int:
    """Real decompressed size of one entry, stopping as soon as it
    passes `cap` (returns `cap + 1` then)."""
    raw = _raw_entry_bytes(archive, info)
    if info.compress_type == zipfile.ZIP_STORED:
        return len(raw)
    inflater = zlib.decompressobj(-zlib.MAX_WBITS)
    produced = 0
    pending = raw
    try:
        while True:
            # `max_length` bounds each call's output; the rest of the
            # input waits in `unconsumed_tail`, and a call with no new
            # input drains output zlib still holds.
            out = inflater.decompress(pending, _READ_CHUNK)
            produced += len(out)
            if produced > cap:
                return cap + 1
            pending = inflater.unconsumed_tail
            if inflater.eof or (not out and not pending):
                break
    except zlib.error as exc:
        raise ZipLimitError("Corrupt zip entry.") from exc
    return min(produced, cap + 1)


def _raw_entry_bytes(archive: zipfile.ZipFile, info: zipfile.ZipInfo) -> bytes:
    """The entry's compressed payload, located via its local file
    header (no decompression)."""
    fp = archive.fp
    if fp is None:  # pragma: no cover - archive is open here
        raise ZipLimitError("Not a readable zip archive.")
    fp.seek(info.header_offset)
    header = fp.read(30)
    if len(header) != 30 or header[:4] != _LFH_SIG:
        raise ZipLimitError("Malformed zip local header.")
    name_len = int.from_bytes(header[26:28], "little")
    extra_len = int.from_bytes(header[28:30], "little")
    fp.seek(info.header_offset + 30 + name_len + extra_len)
    raw = fp.read(info.compress_size)
    if len(raw) != info.compress_size:
        raise ZipLimitError("Truncated zip entry.")
    return raw
