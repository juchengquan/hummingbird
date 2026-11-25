"""The code sandbox's pure helpers (wave 8, Q92), ported case for case from
Next's `lib/server/code-sandbox/{marshal,mount-files,mime}.test.ts`, so both
sides keep the same caps, notes and file conventions."""

from __future__ import annotations

import base64

import pytest

from agent_py.code_sandbox.marshal import RawRun, normalize_table, to_code_run_result
from agent_py.code_sandbox.mime import mime_for_name
from agent_py.code_sandbox.mount_files import MountManifestEntry, resolve_mount_files


def _raw(**kw: object) -> RawRun:
    base: dict[str, object] = {
        "stdout": "",
        "stderr": "",
        "exit_code": 0,
        "images": [],
        "timed_out": False,
    }
    base.update(kw)
    return RawRun(**base)  # type: ignore[arg-type]


def _kinds(result: object, kind: str) -> list[dict[str, object]]:
    return [r for r in result.results if r["type"] == kind]  # type: ignore[attr-defined]


# --- to_code_run_result ---------------------------------------------------------------


def test_exit_0_is_ok_with_stdout_as_a_text_result() -> None:
    r = to_code_run_result(_raw(stdout="4\n"))
    assert r.ok and r.stdout == "4\n"
    assert {"type": "text", "value": "4\n"} in r.results


def test_a_non_zero_exit_is_a_runtime_error_carrying_stderr() -> None:
    r = to_code_run_result(_raw(stderr="Traceback...", exit_code=1))
    assert not r.ok and r.stderr == "Traceback..."
    assert r.error is not None and r.error.code == "runtime"


def test_timed_out_is_a_timeout_whatever_the_exit() -> None:
    r = to_code_run_result(_raw(exit_code=137, timed_out=True))
    assert not r.ok and r.error is not None and r.error.code == "timeout"


def test_an_upstream_error_wins_over_exit_and_timeout() -> None:
    r = to_code_run_result(_raw(exit_code=137, timed_out=True, upstream_error="boot failed"))
    assert not r.ok
    assert r.error is not None and (r.error.code, r.error.message) == ("upstream", "boot failed")


def test_images_become_base64_image_results() -> None:
    r = to_code_run_result(_raw(images=[("png", "AAAA")]))
    assert {"type": "image", "format": "png", "data": "AAAA"} in r.results


def test_empty_stdout_gives_no_text_result() -> None:
    assert _kinds(to_code_run_result(_raw(images=[("png", "AAAA")])), "text") == []


def test_stdout_is_truncated_at_the_cap_with_a_marker() -> None:
    r = to_code_run_result(_raw(stdout="x" * 300_000))
    assert len(r.stdout) <= 256_000 + 32
    assert "truncated" in r.stdout


def test_images_beyond_the_result_cap_are_dropped_whole() -> None:
    huge = "a" * 6_000_000
    r = to_code_run_result(_raw(images=[("png", huge), ("png", huge)]))
    assert len(_kinds(r, "image")) == 1


# --- normalize_table -------------------------------------------------------------------


def test_a_columns_rows_table_is_stringified() -> None:
    assert normalize_table({"columns": ["a", "b"], "rows": [[1, 2], [3, 4]]}) == {
        "columns": ["a", "b"],
        "rows": [["1", "2"], ["3", "4"]],
    }


def test_pandas_split_uses_data_and_ignores_index() -> None:
    assert normalize_table({"columns": ["x"], "data": [[True], [None]], "index": [0, 1]}) == {
        "columns": ["x"],
        "rows": [["true"], [""]],
    }


def test_non_scalar_cells_are_json_encoded() -> None:
    assert normalize_table({"columns": ["c"], "rows": [[{"k": 1}]]}) == {
        "columns": ["c"],
        "rows": [['{"k":1}']],
    }


@pytest.mark.parametrize("value", [None, {"columns": "nope"}, {"rows": [[1]]}, 42])
def test_garbage_is_not_a_table(value: object) -> None:
    assert normalize_table(value) is None


# --- tables in results -----------------------------------------------------------------


def test_tables_become_table_cells() -> None:
    r = to_code_run_result(_raw(tables=[{"columns": ["a"], "rows": [["1"]]}]))
    assert {"type": "table", "columns": ["a"], "rows": [["1"]]} in r.results


def test_unparseable_table_entries_are_ignored() -> None:
    r = to_code_run_result(_raw(tables=[42, {"columns": ["a"], "rows": [["1"]]}]))
    assert len(_kinds(r, "table")) == 1


def test_columns_and_rows_are_capped_and_the_truncation_noted() -> None:
    cols = [f"c{i}" for i in range(60)]
    rows = [["x"] * 60 for _ in range(1100)]
    r = to_code_run_result(_raw(tables=[{"columns": cols, "rows": rows}]))
    (table,) = _kinds(r, "table")
    assert len(table["columns"]) == 50  # type: ignore[arg-type]
    assert len(table["rows"]) == 1000  # type: ignore[arg-type]
    assert len(table["rows"][0]) == 50  # type: ignore[index]
    assert any("truncated" in str(t["value"]).lower() for t in _kinds(r, "text"))


def test_long_cells_are_capped() -> None:
    r = to_code_run_result(_raw(tables=[{"columns": ["a"], "rows": [["y" * 600]]}]))
    (table,) = _kinds(r, "table")
    assert len(table["rows"][0][0]) <= 501  # type: ignore[index]


def test_a_small_table_within_budget_is_kept() -> None:
    r = to_code_run_result(_raw(stdout="hi\n", tables=[{"columns": ["a"], "rows": [["1"]]}]))
    assert len(_kinds(r, "table")) == 1


def test_an_image_using_most_of_the_budget_drops_a_table_that_no_longer_fits() -> None:
    rows = [["z" * 500, "z" * 500] for _ in range(1000)]
    r = to_code_run_result(
        _raw(images=[("png", "a" * 9_500_000)], tables=[{"columns": ["x", "y"], "rows": rows}])
    )
    assert len(_kinds(r, "image")) == 1
    assert _kinds(r, "table") == []
    assert any("dropped" in str(t["value"]).lower() for t in _kinds(r, "text"))


def test_output_files_pass_through_with_their_size() -> None:
    data = base64.b64encode(b"col1,col2\n1,2\n").decode()
    r = to_code_run_result(_raw(files=[("report.csv", "text/csv", data)]))
    assert [(f.name, f.mime_type, f.size_bytes, f.data) for f in r.files] == [
        ("report.csv", "text/csv", len(b"col1,col2\n1,2\n"), data)
    ]


def test_no_files_written_is_an_empty_list() -> None:
    assert to_code_run_result(_raw(stdout="hi")).files == []


# --- resolve_mount_files ---------------------------------------------------------------


def _enc(s: str) -> str:
    return base64.b64encode(s.encode()).decode()


MANIFEST = [
    MountManifestEntry(name="local.csv", file_id="f1", data_base64=_enc("a,b\n1,2\n")),
    MountManifestEntry(name="cloud.parquet", file_id="f2"),
]


async def _download(file_id: str) -> bytes | None:
    return b"\x01\x02\x03" if file_id == "f2" else None


async def test_a_local_file_is_decoded_at_the_mount_dir() -> None:
    r = await resolve_mount_files(["local.csv"], MANIFEST, _download)
    assert [(f.path, f.data) for f in r.files] == [("/mnt/files/local.csv", b"a,b\n1,2\n")]
    assert r.notes == []


async def test_a_cloud_file_is_downloaded() -> None:
    r = await resolve_mount_files(["cloud.parquet"], MANIFEST, _download)
    assert r.files[0].data == b"\x01\x02\x03"


async def test_an_unknown_name_is_a_note() -> None:
    r = await resolve_mount_files(["nope.txt"], MANIFEST, _download)
    assert r.files == [] and "nope.txt" in " ".join(r.notes)


async def test_a_cloud_file_that_does_not_load_is_a_note() -> None:
    m = [MountManifestEntry(name="x.bin", file_id="missing")]
    r = await resolve_mount_files(["x.bin"], m, _download)
    assert r.files == [] and "x.bin" in " ".join(r.notes)


async def test_a_download_that_raises_is_a_note_too() -> None:
    async def boom(_file_id: str) -> bytes | None:
        raise RuntimeError("storage down")

    m = [MountManifestEntry(name="x.bin", file_id="f2")]
    r = await resolve_mount_files(["x.bin"], m, boom)
    assert r.files == [] and "could not be loaded" in " ".join(r.notes)


async def test_a_file_over_the_per_file_cap_is_dropped() -> None:
    m = [MountManifestEntry(name="big", file_id="b", data_base64=_enc("Z" * 11_000_000))]
    r = await resolve_mount_files(["big"], m, _download)
    assert r.files == [] and "too large" in " ".join(r.notes).lower()


async def test_a_traversal_name_stays_under_the_mount_dir() -> None:
    m = [MountManifestEntry(name="../../etc/passwd", file_id="f", data_base64=_enc("x"))]
    r = await resolve_mount_files(["../../etc/passwd", "passwd"], m, _download)
    for f in r.files:
        assert f.path.startswith("/mnt/files/") and ".." not in f.path


async def test_two_names_that_sanitize_alike_get_distinct_paths() -> None:
    m = [
        MountManifestEntry(name="a b.csv", file_id="x1", data_base64=_enc("one")),
        MountManifestEntry(name="a+b.csv", file_id="x2", data_base64=_enc("two")),
    ]
    r = await resolve_mount_files(["a b.csv", "a+b.csv"], m, _download)
    assert [(f.path, f.data) for f in r.files] == [
        ("/mnt/files/a_b.csv", b"one"),
        ("/mnt/files/a_b-1.csv", b"two"),
    ]
    assert "collision" in " ".join(r.notes).lower()


# --- mime_for_name ---------------------------------------------------------------------


def test_common_deliverables_have_their_mime() -> None:
    assert mime_for_name("report.csv") == "text/csv"
    assert mime_for_name("data.json") == "application/json"
    assert (
        mime_for_name("out.xlsx")
        == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )
    assert mime_for_name("doc.pdf") == "application/pdf"
    assert mime_for_name("archive.zip") == "application/zip"
    assert mime_for_name("notes.txt") == "text/plain"


def test_the_extension_is_case_insensitive() -> None:
    assert mime_for_name("REPORT.CSV") == "text/csv"


def test_unknown_or_missing_extensions_are_octet_stream() -> None:
    assert mime_for_name("mystery.bin") == "application/octet-stream"
    assert mime_for_name("noext") == "application/octet-stream"
