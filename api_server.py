"""HTTP API for the Lauki Phones dashboard.

Issues LiveKit tokens, proxies existing LangChain tools, and serves analytics
from recorded activity. Does not reimplement plan, balance, or coverage logic.
"""

from __future__ import annotations

import asyncio
import time
import uuid
from datetime import timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from config import settings
from session_store import (
    TOOL_CATEGORIES,
    compute_analytics,
    create_session,
    get_session,
    get_settings,
    list_sessions,
    list_tool_events,
    record_tool_event,
    update_session,
    update_settings,
)

WEB_DIR = Path(__file__).resolve().parent / "web"

app = FastAPI(title="Lauki Phones Support API", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_tools_module = None
_tools_error: str | None = None


def _livekit_public() -> dict[str, Any]:
    parsed = urlparse(settings.livekit_url)
    host = parsed.hostname or ""
    configured = bool(settings.livekit_url and settings.livekit_api_key and settings.livekit_api_secret)
    return {
        "configured": configured,
        "url": settings.livekit_url if configured else None,
        "host": host,
    }


def _load_tools() -> Any:
    global _tools_module, _tools_error
    if _tools_module is not None:
        return _tools_module
    if _tools_error:
        raise RuntimeError(_tools_error)
    try:
        from langchain_agent import tools as tools_mod

        _tools_module = tools_mod
        return _tools_module
    except Exception as exc:
        _tools_error = str(exc)
        raise


@app.on_event("startup")
async def _startup() -> None:
    try:
        await asyncio.to_thread(_load_tools)
    except Exception:
        pass


class TokenRequest(BaseModel):
    identity: str | None = None
    room: str | None = None


class SessionCreate(BaseModel):
    id: str | None = None
    room: str | None = None
    identity: str | None = None
    phone_number: str | None = None
    category: str | None = None
    source: str = "voice"


class SessionUpdate(BaseModel):
    phone_number: str | None = None
    phone_masked: str | None = None
    category: str | None = None
    duration_seconds: int | None = None
    status: str | None = None
    escalated: bool | None = None
    ended_at: str | None = None
    response_latencies_ms: list[int] | None = None
    transcript: list[dict[str, Any]] | None = None
    tools: list[dict[str, Any]] | None = None
    append_transcript: list[dict[str, Any]] | None = None
    append_tools: list[dict[str, Any]] | None = None


class SearchPlansBody(BaseModel):
    query: str
    session_id: str | None = None


class BalanceBody(BaseModel):
    phone_number: str
    session_id: str | None = None


class NetworkBody(BaseModel):
    region: str = "default"
    session_id: str | None = None


class RecommendBody(BaseModel):
    usage_type: str
    data_gb: int = 0
    voice_min: int = 0
    session_id: str | None = None


class PlanDetailsBody(BaseModel):
    plan_name: str
    session_id: str | None = None


class EscalateBody(BaseModel):
    reason: str
    session_id: str | None = None


class SettingsBody(BaseModel):
    agent_name: str | None = None
    agent_available: bool | None = None


async def _invoke_tool(name: str, payload: dict[str, Any], session_id: str | None) -> dict[str, Any]:
    started = time.perf_counter()
    try:
        tools_mod = _load_tools()
        fn = getattr(tools_mod, name)
        result = await asyncio.to_thread(fn.invoke, payload)
        ok = True
    except Exception as exc:
        result = str(exc)
        ok = False
    latency_ms = int((time.perf_counter() - started) * 1000)
    event = record_tool_event(
        tool=name,
        arguments=payload,
        result=str(result),
        ok=ok,
        latency_ms=latency_ms,
        session_id=session_id,
        source="dashboard",
    )
    if not ok:
        raise HTTPException(status_code=503, detail={"message": str(result), "event": event})
    return {
        "ok": True,
        "tool": name,
        "category": TOOL_CATEGORIES.get(name, "general"),
        "result": result,
        "latency_ms": latency_ms,
        "event": event,
    }


@app.get("/api/health")
async def health() -> dict[str, Any]:
    tools_ok = False
    qdrant_ok = False
    tools_error = _tools_error
    try:
        tools_mod = _load_tools()
        tools_ok = True
        qdrant_ok = tools_mod.qdrant is not None
        try:
            tools_mod.qdrant.get_collection(settings.collection_name)
            qdrant_ok = True
        except Exception as exc:
            qdrant_ok = False
            tools_error = str(exc)
    except Exception as exc:
        tools_error = str(exc)

    livekit = _livekit_public()
    operator = get_settings()
    return {
        "backend": "ok",
        "tools_ready": tools_ok,
        "qdrant_ready": qdrant_ok,
        "tools_error": tools_error,
        "livekit": livekit,
        "agent": {
            "name": operator.get("agent_name") or "Lauki AI Support Assistant",
            "available": bool(operator.get("agent_available", True)),
            "worker": "A LiveKit agent worker must be running separately (`python -m voice_agent.main dev`) to join voice rooms.",
        },
    }


@app.post("/api/livekit/token")
async def livekit_token(body: TokenRequest | None = None) -> dict[str, Any]:
    body = body or TokenRequest()
    livekit = _livekit_public()
    if not livekit["configured"]:
        raise HTTPException(status_code=503, detail="LiveKit is not configured on the server.")

    from livekit.api import AccessToken, VideoGrants

    room = body.room or f"lauki-support-{uuid.uuid4().hex[:8]}"
    identity = body.identity or f"customer-{uuid.uuid4().hex[:8]}"
    try:
        token = (
            AccessToken(settings.livekit_api_key, settings.livekit_api_secret)
            .with_identity(identity)
            .with_name("Lauki customer")
            .with_ttl(timedelta(hours=2))
            .with_grants(
                VideoGrants(
                    room_join=True,
                    room=room,
                    can_publish=True,
                    can_subscribe=True,
                    can_publish_data=True,
                )
            )
            .to_jwt()
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Could not issue LiveKit token: {exc}") from exc

    return {
        "token": token,
        "url": settings.livekit_url,
        "room": room,
        "identity": identity,
    }


@app.get("/api/catalog/plans")
async def catalog_plans() -> dict[str, Any]:
    try:
        tools_mod = _load_tools()
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    plans = []
    for name, details in tools_mod.MOCK_PLANS_DB.items():
        plans.append({"name": name, **details})
    return {"plans": plans}


@app.get("/api/catalog/regions")
async def catalog_regions() -> dict[str, Any]:
    try:
        tools_mod = _load_tools()
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    regions = sorted(k for k in tools_mod.MOCK_NETWORK_STATUS if k != "default")
    return {"regions": regions, "default": "default"}


@app.post("/api/tools/search_plans")
async def tool_search_plans(body: SearchPlansBody) -> dict[str, Any]:
    return await _invoke_tool("search_plans", {"query": body.query}, body.session_id)


@app.post("/api/tools/check_account_balance")
async def tool_balance(body: BalanceBody) -> dict[str, Any]:
    phone = body.phone_number.strip()
    if not phone.isdigit() or len(phone) != 10:
        raise HTTPException(
            status_code=400,
            detail="Enter a valid 10-digit Indian mobile number. Do not send OTP, PIN, or passwords.",
        )
    return await _invoke_tool("check_account_balance", {"phone_number": phone}, body.session_id)


@app.post("/api/tools/check_network_status")
async def tool_network(body: NetworkBody) -> dict[str, Any]:
    return await _invoke_tool("check_network_status", {"region": body.region}, body.session_id)


@app.post("/api/tools/get_plan_recommendation")
async def tool_recommend(body: RecommendBody) -> dict[str, Any]:
    return await _invoke_tool(
        "get_plan_recommendation",
        {"usage_type": body.usage_type, "data_gb": body.data_gb, "voice_min": body.voice_min},
        body.session_id,
    )


@app.post("/api/tools/get_plan_details")
async def tool_plan_details(body: PlanDetailsBody) -> dict[str, Any]:
    return await _invoke_tool("get_plan_details", {"plan_name": body.plan_name}, body.session_id)


@app.post("/api/tools/escalate_to_support")
async def tool_escalate(body: EscalateBody) -> dict[str, Any]:
    return await _invoke_tool("escalate_to_support", {"reason": body.reason}, body.session_id)


@app.get("/api/sessions")
async def sessions() -> dict[str, Any]:
    return {"sessions": list_sessions()}


@app.get("/api/sessions/{session_id}")
async def session_detail(session_id: str) -> dict[str, Any]:
    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found.")
    return session


@app.post("/api/sessions")
async def session_create(body: SessionCreate) -> dict[str, Any]:
    return create_session(body.model_dump(exclude_none=True))


@app.patch("/api/sessions/{session_id}")
async def session_patch(session_id: str, body: SessionUpdate) -> dict[str, Any]:
    session = update_session(session_id, body.model_dump(exclude_none=True))
    if not session:
        raise HTTPException(status_code=404, detail="Session not found.")
    return session


@app.get("/api/tools/events")
async def tool_events() -> dict[str, Any]:
    return {"events": list_tool_events()}


@app.get("/api/analytics")
async def analytics() -> dict[str, Any]:
    return compute_analytics()


@app.get("/api/settings")
async def read_settings() -> dict[str, Any]:
    operator = get_settings()
    livekit = _livekit_public()
    return {
        "agent_name": operator.get("agent_name"),
        "agent_available": operator.get("agent_available"),
        "backend_url_note": "The dashboard uses this origin. Secrets stay on the server.",
        "livekit": livekit,
        "instructions_editable": False,
    }


@app.put("/api/settings")
async def write_settings(body: SettingsBody) -> dict[str, Any]:
    return update_settings(body.model_dump(exclude_none=True))


if WEB_DIR.exists():
    app.mount("/css", StaticFiles(directory=WEB_DIR / "css"), name="css")
    app.mount("/js", StaticFiles(directory=WEB_DIR / "js"), name="js")

    @app.get("/")
    async def index() -> FileResponse:
        return FileResponse(WEB_DIR / "index.html")

    @app.get("/{path:path}")
    async def spa_fallback(path: str) -> FileResponse:
        if path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Not found.")
        candidate = WEB_DIR / path
        if candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(WEB_DIR / "index.html")
