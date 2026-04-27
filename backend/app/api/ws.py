from __future__ import annotations

import asyncio
from dataclasses import asdict

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.engagement import current

router = APIRouter(prefix="/ws", tags=["ws"])


@router.websocket("/engagements/{engagement_id}/console")
async def engagement_console(ws: WebSocket, engagement_id: int) -> None:
    """Live stdout/stderr stream for an engagement.

    Plan §7: replays the last ~1000 buffered lines on connect, then tails
    new output until the engagement ends or the client disconnects.
    """
    await ws.accept()
    eng = current()
    if eng is None or eng.engagement_id != engagement_id:
        await ws.send_json({"type": "error", "msg": "engagement not active"})
        await ws.close()
        return

    sub = eng.subscribe_lines()
    try:
        async for line in sub:
            await ws.send_json({"type": "line", "line": asdict(line)})
    except WebSocketDisconnect:
        return
    except Exception as e:  # noqa: BLE001
        try:
            await ws.send_json({"type": "error", "msg": str(e)})
        except Exception:
            pass
    finally:
        # Aclose the async iterator so the subscriber queue is removed.
        await sub.aclose()  # type: ignore[attr-defined]


@router.websocket("/engagements/{engagement_id}/state")
async def engagement_state(ws: WebSocket, engagement_id: int) -> None:
    """Engagement and run status changes (run_started, run_finished, etc.)."""
    await ws.accept()
    eng = current()
    if eng is None or eng.engagement_id != engagement_id:
        await ws.send_json({"type": "error", "msg": "engagement not active"})
        await ws.close()
        return

    sub = eng.subscribe_state()
    try:
        async for evt in sub:
            await ws.send_json(evt)
    except WebSocketDisconnect:
        return
    except Exception as e:  # noqa: BLE001
        try:
            await ws.send_json({"type": "error", "msg": str(e)})
        except Exception:
            pass
    finally:
        await sub.aclose()  # type: ignore[attr-defined]
