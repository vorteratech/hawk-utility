from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.db import get_conn
from app.engagement import current, make_run_script

router = APIRouter(tags=["runs"])


def _row_to_dict(row) -> dict:
    return {k: row[k] for k in row.keys()}


class RunBody(BaseModel):
    cmdlet: str = Field(min_length=1)
    # Free-form; the front-end picks the right shape per cmdlet.
    params: dict[str, Any] = Field(default_factory=dict)


class StdinBody(BaseModel):
    text: str


def _params_to_pwsh_args(params: dict[str, Any]) -> str:
    """Render a params dict to the `-Key 'value'` shape PowerShell expects.

    Strings are single-quoted (PowerShell single-quoted strings are literal
    aside from doubled '' to escape a single quote). Lists become comma-
    separated quoted strings. Booleans become switch parameters.
    """

    def quote(v: Any) -> str:
        if isinstance(v, bool):
            return "$true" if v else "$false"
        if isinstance(v, (int, float)):
            return str(v)
        s = str(v).replace("'", "''")
        return f"'{s}'"

    parts: list[str] = []
    for k, v in params.items():
        if isinstance(v, list):
            joined = ",".join(quote(item) for item in v)
            parts.append(f"-{k} {joined}")
        elif isinstance(v, bool):
            if v:
                parts.append(f"-{k}")
        else:
            parts.append(f"-{k} {quote(v)}")
    return " ".join(parts)


@router.post("/api/engagements/{engagement_id}/runs", status_code=201)
async def create_run(engagement_id: int, body: RunBody) -> dict:
    eng = current()
    if eng is None or eng.engagement_id != engagement_id:
        raise HTTPException(404, "no active engagement with that id")

    args = _params_to_pwsh_args(body.params)
    invocation = f"{body.cmdlet} {args}".strip()
    script = make_run_script(invocation)

    try:
        run_id = await eng.register_run(
            cmdlet=body.cmdlet,
            params=body.params,
            invocation_script=script,
            clean_invocation=invocation,
        )
    except RuntimeError as e:
        raise HTTPException(409, str(e))

    # Fire-and-forget completion watcher. Updates the runs row + emits state
    # when the sentinel arrives. The HTTP response returns immediately.
    asyncio.create_task(eng.await_run(run_id))

    with get_conn() as conn:
        row = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
    return {"run": _row_to_dict(row) if row else {"id": run_id}}


@router.get("/api/runs/{run_id}")
def get_run(run_id: int) -> dict:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
    if not row:
        raise HTTPException(404, "run not found")
    return {"run": _row_to_dict(row)}


@router.post("/api/engagements/{engagement_id}/stdin")
async def send_stdin(engagement_id: int, body: StdinBody) -> dict:
    """Pipe a line into the engagement subprocess's stdin (plan §5.3)."""
    eng = current()
    if eng is None or eng.engagement_id != engagement_id:
        raise HTTPException(404, "no active engagement with that id")
    await eng.send_stdin(body.text)
    return {"ok": True}
