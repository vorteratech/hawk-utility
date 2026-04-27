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
    return {
        "engagement": _row_to_dict(row),
        "runs": [_row_to_dict(r) for r in runs],
    }


@router.post("/{engagement_id}/end")
async def end_engagement(engagement_id: int) -> dict:
    eng = current()
    if eng is None or eng.engagement_id != engagement_id:
        raise HTTPException(404, "no active engagement with that id")
    await eng.terminate()
    await clear_current(eng)
    return {"ok": True}
