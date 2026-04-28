from __future__ import annotations

import asyncio
import os
import signal
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.config import ENGAGEMENTS_ROOT
from app.db import get_conn
from app.engagement import (
    EngagementProcess,
    build_engagement_folder,
    clear_current,
    current,
    set_current,
)
from app.preflight import run_all

router = APIRouter(prefix="/api/engagements", tags=["engagements"])


def _row_to_dict(row) -> dict:
    return {k: row[k] for k in row.keys()}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class CreateEngagementBody(BaseModel):
    client_name: str = Field(min_length=1, max_length=120)
    start_date: str = Field(description="ISO date YYYY-MM-DD")
    end_date: str = Field(description="ISO date YYYY-MM-DD")
    tenant_hint: Optional[str] = None
    skip_preflight: bool = Field(default=False, description="Dev escape hatch only")
    skip_auth: bool = Field(default=False, description="Dev escape hatch -- do not run Connect-MgGraph / Connect-ExchangeOnline")


@router.get("")
def list_engagements() -> dict:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM engagements ORDER BY created_at DESC"
        ).fetchall()
    return {"engagements": [_row_to_dict(r) for r in rows]}


@router.get("/active")
def active_engagement() -> dict:
    eng = current()
    if eng is None or not eng.is_alive():
        return {"engagement": None}
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM engagements WHERE id = ?", (eng.engagement_id,)
        ).fetchone()
    return {"engagement": _row_to_dict(row) if row else None}


@router.post("", status_code=201)
async def create_engagement(body: CreateEngagementBody) -> dict:
    # v1 invariant: one engagement at a time (plan §4).
    if current() is not None and current().is_alive():
        raise HTTPException(409, "an engagement is already active")

    if not body.skip_preflight:
        pre = run_all()
        if not pre["ready"]:
            raise HTTPException(412, {"error": "preflight not ready", "checks": pre["checks"]})

    folder = build_engagement_folder(body.client_name)
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO engagements (client_name, tenant_hint, start_date, end_date, output_folder, status, created_at) "
            "VALUES (?, ?, ?, ?, ?, 'starting', ?)",
            (
                body.client_name,
                body.tenant_hint,
                body.start_date,
                body.end_date,
                str(folder),
                _now_iso(),
            ),
        )
        engagement_id = cur.lastrowid
    assert engagement_id is not None

    eng = EngagementProcess(engagement_id, folder)
    await set_current(eng)
    try:
        await eng.start()
    except Exception:
        await clear_current(eng)
        with get_conn() as conn:
            conn.execute(
                "UPDATE engagements SET status='crashed', ended_at=? WHERE id=?",
                (_now_iso(), engagement_id),
            )
        raise

    if body.skip_auth:
        # Dev path -- mark as authenticated immediately so the cmdlet picker
        # is enabled. HAWK calls will fail loudly if the user actually tries
        # them without real auth.
        eng._auth_complete = True
    else:
        # Fire-and-forget. Device-code prompts and completion fire as state
        # events on /ws/engagements/{id}/state; the frontend renders the
        # device-code modal and gates the cmdlet picker on auth_complete.
        asyncio.create_task(eng.connect())

    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM engagements WHERE id = ?", (engagement_id,)
        ).fetchone()
    return {"engagement": _row_to_dict(row)}


@router.get("/{engagement_id}")
def get_engagement(engagement_id: int) -> dict:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM engagements WHERE id = ?", (engagement_id,)
        ).fetchone()
        if not row:
            raise HTTPException(404, "engagement not found")
        runs = conn.execute(
            "SELECT * FROM runs WHERE engagement_id = ? ORDER BY id DESC", (engagement_id,)
        ).fetchall()
    eng = current()
    auth_complete = (
        eng is not None
        and eng.engagement_id == engagement_id
        and eng._auth_complete
    )
    return {
        "engagement": _row_to_dict(row),
        "runs": [_row_to_dict(r) for r in runs],
        "auth_complete": auth_complete,
    }


@router.delete("/{engagement_id}")
def delete_engagement(engagement_id: int, delete_folder: bool = False) -> dict:
    """Remove an engagement record. Refuses if the engagement is still
    active in memory -- end it first. The output folder is preserved by
    default since it's the unit of forensic handoff (plan §6.3); pass
    ?delete_folder=true to remove it too."""
    eng = current()
    if eng is not None and eng.engagement_id == engagement_id:
        raise HTTPException(409, "engagement is active; end it before deleting")

    with get_conn() as conn:
        row = conn.execute(
            "SELECT status, output_folder FROM engagements WHERE id = ?",
            (engagement_id,),
        ).fetchone()
        if not row:
            raise HTTPException(404, "engagement not found")
        if row["status"] in ("starting", "active"):
            raise HTTPException(
                409,
                "engagement is marked active in DB; end it (or wait for the zombie sweep) before deleting",
            )
        conn.execute("DELETE FROM runs WHERE engagement_id = ?", (engagement_id,))
        conn.execute("DELETE FROM engagements WHERE id = ?", (engagement_id,))

    folder_removed = False
    if delete_folder and row["output_folder"]:
        folder = Path(row["output_folder"])
        if folder.exists():
            import shutil

            shutil.rmtree(folder, ignore_errors=True)
            folder_removed = True

    return {"ok": True, "folder_removed": folder_removed}


@router.post("/{engagement_id}/reconnect-exo")
async def reconnect_exo(engagement_id: int) -> dict:
    """Re-run Connect-ExchangeOnline in the engagement's subprocess. Used
    to recover from HAWK issue #292 ('Module could not be correctly
    formed')."""
    eng = current()
    if eng is None or eng.engagement_id != engagement_id:
        raise HTTPException(404, "no active engagement with that id")
    asyncio.create_task(eng.reconnect_exo())
    return {"ok": True}


@router.post("/{engagement_id}/end")
async def end_engagement(engagement_id: int) -> dict:
    eng = current()
    if eng is not None and eng.engagement_id == engagement_id:
        await eng.terminate()
        await clear_current(eng)
        return {"ok": True}

    # No live subprocess for this engagement. If the DB still has it as
    # active/starting (zombie state from a wrapper restart, missed sweep,
    # etc.), close it out cleanly so the UI isn't stuck on a dead row.
    with get_conn() as conn:
        row = conn.execute(
            "SELECT status FROM engagements WHERE id = ?", (engagement_id,)
        ).fetchone()
        if not row:
            raise HTTPException(404, "engagement not found")
        if row["status"] in ("starting", "active"):
            now = _now_iso()
            conn.execute(
                "UPDATE engagements SET status='crashed', ended_at=?, pwsh_pid=NULL WHERE id=?",
                (now, engagement_id),
            )
            conn.execute(
                "UPDATE runs SET status='interrupted', ended_at=? "
                "WHERE engagement_id = ? AND status IN ('queued', 'running')",
                (now, engagement_id),
            )
            return {"ok": True, "note": "engagement was a zombie; marked crashed"}
    return {"ok": True, "note": "engagement was already ended"}
