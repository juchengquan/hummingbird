"""agent-py's attachment renderer (`runs/context.py`) against the TS
original (`lib/server/attachments/render.ts`).

`fixtures/attachments_render_parity.json` holds the TS renderer's output
for a table of cases (budget cuts, omitted footers, MCP errors, bookmarks,
the meta-only footer, cloud file ids and the `searchFiles` notes, Q47);
`lib/server/attachments/render.parity.test.ts` generates it and fails when
the TS side drifts. Here the Python port must produce exactly the same.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from agent_py.runs.context import (
    BookmarkItem,
    FileItem,
    McpItem,
    format_bytes,
    render_attachments_prompt,
    render_meta_only_files_prompt,
)

FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures" / "attachments_render_parity.json").read_text()
)


def _item(raw: dict[str, Any]) -> FileItem | McpItem | BookmarkItem:
    kind = raw["kind"]
    if kind == "file":
        s = raw["summary"]
        return FileItem(
            name=s["name"],
            size=s["size"],
            type=s["type"],
            text=s.get("text"),
            truncated=s.get("truncated") is True,
            kind=s.get("kind"),
            retrieval_mode=s.get("retrievalMode", "inline"),
            id=s.get("id"),
        )
    if kind == "mcp_resource":
        return McpItem(
            server_name=raw["serverName"],
            resource_name=raw["resourceName"],
            text=raw.get("text"),
            error=raw.get("error"),
        )
    assert kind == "url_bookmark"
    return BookmarkItem(
        title=raw["title"],
        url=raw["url"],
        content=raw["content"],
        truncated=raw["truncated"],
        fetched_at=raw.get("fetchedAt"),
    )


@pytest.mark.parametrize("case", FIXTURE["cases"], ids=lambda c: c["name"])
def test_matches_the_ts_renderer(case: dict[str, Any]) -> None:
    items = [_item(a) for a in case["attachments"]]
    rendered = render_attachments_prompt(
        items, case["budget"], search_files_enabled=case["searchFilesEnabled"]
    )
    assert rendered == case["expected"]["attachments"]
    files = [i for i in items if isinstance(i, FileItem)]
    assert render_meta_only_files_prompt(files) == case["expected"]["metaOnly"]


def test_the_fixture_covers_the_q47_notes() -> None:
    blob = json.dumps(FIXTURE)
    assert "fileId: " in blob
    assert "is searchable" in blob
    assert "Call `searchFiles` with fileId" in blob


@pytest.mark.parametrize(
    ("n", "out"),
    [
        (0, "0 B"),
        (1, "1 B"),
        (1024, "1 KB"),
        (1280, "1.3 KB"),
        (1536, "1.5 KB"),
        (10**12, "931.3 GB"),
    ],
)
def test_format_bytes(n: int, out: str) -> None:
    assert format_bytes(n) == out
