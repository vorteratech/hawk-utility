from __future__ import annotations

import csv
import io
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse, PlainTextResponse

from app.db import get_conn

router = APIRouter(prefix="/api/engagements", tags=["files"])

# Caps to keep the wrapper responsive when an investigator clicks a huge file.
CSV_PREVIEW_ROWS = 500
TEXT_PREVIEW_BYTES = 2 * 1024 * 1024  # 2 MB
TREE_MAX_DEPTH = 8


def _engagement_folder(engagement_id: int) -> Path:
    """Look up the engagement's output folder; 404 if no such row."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT output_folder FROM engagements WHERE id = ?",
            (engagement_id,),
        ).fetchone()
    if not row or not row["output_folder"]:
        raise HTTPException(404, "engagement not found")
    folder = Path(row["output_folder"])
    if not folder.exists():
        raise HTTPException(404, f"engagement folder missing on disk: {folder}")
    return folder


def _resolve_safe(engagement_folder: Path, rel_path: str) -> Path:
    """Resolve `rel_path` against `engagement_folder`, ensuring the result
    stays inside it. Anything else is a 400 -- prevents directory-traversal
    via '..' / absolute paths in query parameters."""
    if not rel_path:
        raise HTTPException(400, "missing path")
    candidate = (engagement_folder / rel_path).resolve()
    try:
        candidate.relative_to(engagement_folder.resolve())
    except ValueError:
        raise HTTPException(400, "path escapes engagement folder")
    if not candidate.exists():
        raise HTTPException(404, "file not found")
    return candidate


def _is_investigate(name: str) -> bool:
    return name.startswith("_Investigate_")


def _build_tree(root: Path, depth: int = 0) -> dict[str, Any]:
    """Recursive directory walk into the JSON shape the UI expects."""
    stat = root.stat()
    node: dict[str, Any] = {
        "name": root.name,
        "path": "",  # filled in by caller for non-root
        "kind": "dir" if root.is_dir() else "file",
        "size": stat.st_size if root.is_file() else None,
        "modified": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
    }
    if root.is_file():
        node["is_investigate"] = _is_investigate(root.name)
        return node
    if depth >= TREE_MAX_DEPTH:
        node["children"] = []
        node["truncated"] = True
        return node
    children: list[dict[str, Any]] = []
    try:
        entries = sorted(
            root.iterdir(),
            key=lambda p: (not p.is_dir(), p.name.lower()),
        )
    except PermissionError:
        node["children"] = []
        node["error"] = "permission denied"
        return node
    for entry in entries:
        try:
            child = _build_tree(entry, depth + 1)
        except (OSError, PermissionError):
            continue
        children.append(child)
    node["children"] = children
    return node


def _annotate_paths(node: dict[str, Any], parent_path: str, is_root: bool) -> None:
    """Walk the tree post-build and fill in `path` (relative to engagement
    folder) on every node so the UI can use it for preview / download URLs.
    Root node keeps an empty path; first-level children's path is just
    their name."""
    if not is_root:
        node["path"] = f"{parent_path}/{node['name']}" if parent_path else node["name"]
    for child in node.get("children", []):
        _annotate_paths(child, node["path"], False)


@router.get("/{engagement_id}/files")
def file_tree(engagement_id: int) -> dict:
    folder = _engagement_folder(engagement_id)
    tree = _build_tree(folder)
    tree["name"] = ""  # display root with no name; client knows it's the engagement folder
    _annotate_paths(tree, "", is_root=True)
    return {"root": tree}


@router.get("/{engagement_id}/files/preview")
def preview_file(engagement_id: int, path: str = Query(...)) -> dict:
    folder = _engagement_folder(engagement_id)
    target = _resolve_safe(folder, path)
    if target.is_dir():
        raise HTTPException(400, "preview only supports files")

    suffix = target.suffix.lower()
    size = target.stat().st_size

    if suffix == ".csv":
        return _preview_csv(target, size)
    return _preview_text(target, size)


def _preview_csv(target: Path, size: int) -> dict:
    rows: list[list[str]] = []
    headers: list[str] = []
    total_rows = 0
    truncated = False
    try:
        with target.open("r", encoding="utf-8-sig", newline="") as f:
            reader = csv.reader(f)
            try:
                headers = next(reader)
            except StopIteration:
                headers = []
            for i, row in enumerate(reader):
                total_rows = i + 1
                if i < CSV_PREVIEW_ROWS:
                    rows.append(row)
                else:
                    truncated = True
                    # Keep counting total_rows so the UI can show '500 of N'.
    except UnicodeDecodeError:
        # Fall back to latin-1 -- HAWK should write UTF-8 but be defensive.
        with target.open("r", encoding="latin-1", newline="") as f:
            reader = csv.reader(f)
            try:
                headers = next(reader)
            except StopIteration:
                headers = []
            rows = []
            for i, row in enumerate(reader):
                total_rows = i + 1
                if i < CSV_PREVIEW_ROWS:
                    rows.append(row)
                else:
                    truncated = True
    return {
        "kind": "csv",
        "size": size,
        "headers": headers,
        "rows": rows,
        "total_rows": total_rows,
        "preview_rows": len(rows),
        "truncated": truncated,
    }


def _preview_text(target: Path, size: int) -> dict:
    truncated = size > TEXT_PREVIEW_BYTES
    read_bytes = TEXT_PREVIEW_BYTES if truncated else size
    try:
        with target.open("rb") as f:
            data = f.read(read_bytes)
        text = data.decode("utf-8", errors="replace")
    except OSError as e:
        raise HTTPException(500, f"could not read file: {e}")
    return {
        "kind": "text",
        "size": size,
        "text": text,
        "truncated": truncated,
        "shown_bytes": read_bytes,
    }


@router.get("/{engagement_id}/files/download")
def download_file(engagement_id: int, path: str = Query(...)):
    folder = _engagement_folder(engagement_id)
    target = _resolve_safe(folder, path)
    if target.is_dir():
        raise HTTPException(400, "download only supports files")
    return FileResponse(
        target,
        filename=target.name,
        media_type="application/octet-stream",
    )
