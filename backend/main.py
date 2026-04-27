from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import engagements, runs, system, ws
from app.config import ENGAGEMENTS_ROOT
from app.db import init_db


@asynccontextmanager
async def lifespan(_: FastAPI):
    ENGAGEMENTS_ROOT.mkdir(parents=True, exist_ok=True)
    init_db()
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
app.include_router(runs.router)
app.include_router(ws.router)


@app.get("/")
def root() -> dict:
    return {"name": "hawk-wrapper", "version": "0.1.0"}
