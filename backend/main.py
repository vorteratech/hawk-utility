from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import engagements, files, runs, system, ws
from app.config import ENGAGEMENTS_ROOT
from app.db import get_conn, init_db


def _sweep_zombie_engagements() -> None:
    """Plan §10: any engagement marked 'starting' or 'active' in the DB at
    startup is a zombie -- its subprocess died when the backend restarted.
    Mark them crashed; mark their in-flight runs interrupted."""
    now = datetime.now(timezone.utc).isoformat()
    with get_conn() as conn:
        zombies = conn.execute(
            "SELECT id FROM engagements WHERE status IN ('starting', 'active')"
        ).fetchall()
        if not zombies:
            return
        ids = [z["id"] for z in zombies]
        placeholders = ",".join("?" * len(ids))
        conn.execute(
            f"UPDATE engagements SET status='crashed', ended_at=?, pwsh_pid=NULL "
            f"WHERE id IN ({placeholders})",
            (now, *ids),
        )
        conn.execute(
            f"UPDATE runs SET status='interrupted', ended_at=? "
            f"WHERE engagement_id IN ({placeholders}) AND status IN ('queued', 'running')",
            (now, *ids),
        )


@asynccontextmanager
async def lifespan(_: FastAPI):
    ENGAGEMENTS_ROOT.mkdir(parents=True, exist_ok=True)
    init_db()
    _sweep_zombie_engagements()
    yield


app = FastAPI(title="HAWK Wrapper", version="0.1.0", lifespan=lifespan)

# Vite dev server runs on 5173. Production GUI is served from the same origin
# as the API (uvicorn binds 127.0.0.1:8000) so CORS is only needed in dev.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(system.router)
app.include_router(engagements.router)
app.include_router(files.router)
app.include_router(runs.router)
app.include_router(ws.router)


@app.get("/")
def root() -> dict:
    return {"name": "hawk-wrapper", "version": "0.1.0"}
