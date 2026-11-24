"""Persistent session, tool-event, and analytics store for the dashboard.

Records only real dashboard and voice-session activity. Never fabricates customers.
"""

from __future__ import annotations

import json
import re
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from config import settings

STORE_PATH = Path(settings.qdrant_path).parent / "dashboard" / "store.json"
_LOCK = threading.Lock()

PHONE_RE = re.compile(r"\b(\d{10})\b")

TOOL_CATEGORIES = {
    "search_plans": "plans",
    "check_account_balance": "balance",
    "check_network_status": "network",
    "get_plan_recommendation": "recommendation",
    "get_plan_details": "details",
    "escalate_to_support": "escalation",
}


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def mask_phone(value: str | None) -> str | None:
    if not value:
        return None
    digits = re.sub(r"\D", "", value)
    if len(digits) != 10:
        return None
    return f"{digits[:3]}****{digits[-3:]}"


def _mask_text(text: Any) -> Any:
    if isinstance(text, dict):
        out = {}
        for key, val in text.items():
            if key in {"phone_number", "phone", "customer_number"} and isinstance(val, str):
                out[key] = mask_phone(val) or val
            else:
                out[key] = _mask_text(val)
        return out
    if isinstance(text, list):
        return [_mask_text(item) for item in text]
    if isinstance(text, str):
        return PHONE_RE.sub(lambda m: mask_phone(m.group(1)) or m.group(1), text)
    return text


def _empty() -> dict[str, Any]:
    return {
        "sessions": [],
        "tool_events": [],
        "settings": {
            "agent_name": "Lauki AI Support Assistant",
            "agent_available": True,
        },
    }


def _load() -> dict[str, Any]:
    if not STORE_PATH.exists():
        return _empty()
    try:
        data = json.loads(STORE_PATH.read_text(encoding="utf-8"))
        data.setdefault("sessions", [])
        data.setdefault("tool_events", [])
        data.setdefault("settings", _empty()["settings"])
        return data
    except (json.JSONDecodeError, OSError):
        return _empty()


def _save(data: dict[str, Any]) -> None:
    STORE_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = STORE_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    tmp.replace(STORE_PATH)


def get_settings() -> dict[str, Any]:
    with _LOCK:
        return dict(_load()["settings"])


def update_settings(patch: dict[str, Any]) -> dict[str, Any]:
    allowed = {"agent_name", "agent_available"}
    with _LOCK:
        data = _load()
        for key, value in patch.items():
            if key in allowed:
                data["settings"][key] = value
        _save(data)
        return dict(data["settings"])


def create_session(payload: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = payload or {}
    session = {
        "id": payload.get("id") or f"sess_{uuid.uuid4().hex[:10]}",
        "room": payload.get("room"),
        "identity": payload.get("identity"),
        "phone_masked": mask_phone(payload.get("phone_number")) if payload.get("phone_number") else payload.get("phone_masked"),
        "category": payload.get("category") or "general",
        "duration_seconds": payload.get("duration_seconds") or 0,
        "status": payload.get("status") or "in_progress",
        "escalated": bool(payload.get("escalated")),
        "started_at": payload.get("started_at") or utcnow(),
        "ended_at": payload.get("ended_at"),
        "response_latencies_ms": payload.get("response_latencies_ms") or [],
        "transcript": payload.get("transcript") or [],
        "tools": payload.get("tools") or [],
        "source": payload.get("source") or "voice",
    }
    with _LOCK:
        data = _load()
        data["sessions"].insert(0, session)
        _save(data)
    return session


def get_session(session_id: str) -> dict[str, Any] | None:
    with _LOCK:
        for session in _load()["sessions"]:
            if session["id"] == session_id:
                return session
    return None


def list_sessions() -> list[dict[str, Any]]:
    with _LOCK:
        return list(_load()["sessions"])


def update_session(session_id: str, patch: dict[str, Any]) -> dict[str, Any] | None:
    with _LOCK:
        data = _load()
        for session in data["sessions"]:
            if session["id"] != session_id:
                continue
            if "phone_number" in patch:
                session["phone_masked"] = mask_phone(patch["phone_number"])
            for key in (
                "room",
                "identity",
                "phone_masked",
                "category",
                "duration_seconds",
                "status",
                "escalated",
                "ended_at",
                "response_latencies_ms",
                "transcript",
                "tools",
            ):
                if key in patch:
                    session[key] = patch[key]
            if patch.get("append_transcript"):
                session.setdefault("transcript", []).extend(patch["append_transcript"])
            if patch.get("append_tools"):
                session.setdefault("tools", []).extend(_mask_text(patch["append_tools"]))
            if session.get("escalated"):
                session["status"] = "escalated"
            _save(data)
            return session
    return None


def record_tool_event(
    *,
    tool: str,
    arguments: dict[str, Any],
    result: str,
    ok: bool,
    latency_ms: int,
    session_id: str | None = None,
    source: str = "dashboard",
) -> dict[str, Any]:
    event = {
        "id": f"tool_{uuid.uuid4().hex[:10]}",
        "tool": tool,
        "category": TOOL_CATEGORIES.get(tool, "general"),
        "arguments": _mask_text(arguments),
        "result": _mask_text(result),
        "ok": ok,
        "latency_ms": latency_ms,
        "session_id": session_id,
        "source": source,
        "phone_masked": mask_phone(str(arguments.get("phone_number") or "")),
        "timestamp": utcnow(),
    }
    with _LOCK:
        data = _load()
        data["tool_events"].insert(0, event)
        if session_id:
            for session in data["sessions"]:
                if session["id"] == session_id:
                    session.setdefault("tools", []).append(event)
                    session["category"] = event["category"]
                    if event["phone_masked"]:
                        session["phone_masked"] = event["phone_masked"]
                    if tool == "escalate_to_support" and ok:
                        session["escalated"] = True
                        session["status"] = "escalated"
                    break
        _save(data)
    return event


def list_tool_events() -> list[dict[str, Any]]:
    with _LOCK:
        return list(_load()["tool_events"])


def compute_analytics() -> dict[str, Any]:
    with _LOCK:
        data = _load()
        sessions = data["sessions"]
        events = data["tool_events"]

    voice_sessions = [s for s in sessions if s.get("source") == "voice"]
    unique_phones = {
        s.get("phone_masked")
        for s in sessions
        if s.get("phone_masked")
    }
    unique_phones |= {e.get("phone_masked") for e in events if e.get("phone_masked")}
    unique_phones.discard(None)

    def count_tool(name: str, *, successful_only: bool = False) -> int:
        return sum(
            1
            for e in events
            if e.get("tool") == name and (e.get("ok") if successful_only else True)
        )

    latencies = []
    for session in sessions:
        latencies.extend(session.get("response_latencies_ms") or [])
    latencies.extend(e.get("latency_ms") for e in events if isinstance(e.get("latency_ms"), (int, float)))
    latencies = [n for n in latencies if isinstance(n, (int, float)) and n >= 0]

    ended = [s for s in voice_sessions if s.get("status") in {"resolved", "escalated", "disconnected", "error"}]
    resolved = [s for s in voice_sessions if s.get("status") == "resolved"]
    escalated = [s for s in voice_sessions if s.get("escalated") or s.get("status") == "escalated"]

    daily: dict[str, int] = {}
    for session in voice_sessions:
        day = (session.get("started_at") or "")[:10]
        if day:
            daily[day] = daily.get(day, 0) + 1

    categories: dict[str, int] = {}
    for event in events:
        cat = event.get("category") or "general"
        categories[cat] = categories.get(cat, 0) + 1

    return {
        "total_voice_sessions": len(voice_sessions),
        "total_customers_assisted": len(unique_phones),
        "account_balance_checks": count_tool("check_account_balance", successful_only=True),
        "account_balance_attempts": count_tool("check_account_balance"),
        "plan_enquiries": count_tool("search_plans") + count_tool("get_plan_details"),
        "network_enquiries": count_tool("check_network_status"),
        "plan_recommendations": count_tool("get_plan_recommendation"),
        "escalations": count_tool("escalate_to_support"),
        "average_response_latency_ms": round(sum(latencies) / len(latencies), 1) if latencies else None,
        "session_resolution_rate": round(len(resolved) / len(ended) * 100, 1) if ended else None,
        "successful_vs_escalated": {
            "resolved": len(resolved),
            "escalated": len(escalated),
            "other": max(len(voice_sessions) - len(resolved) - len(escalated), 0),
        },
        "daily_interactions": [
            {"date": day, "count": daily[day]} for day in sorted(daily)
        ],
        "category_distribution": [
            {"category": key, "count": value} for key, value in sorted(categories.items())
        ],
        "unavailable": _unavailable(voice_sessions, events, latencies, ended),
        "generated_at": utcnow(),
    }


def _unavailable(sessions, events, latencies, ended) -> list[str]:
    missing = []
    if not sessions:
        missing.append("Voice session counts appear after a LiveKit session is started and ended from this dashboard.")
    if not events:
        missing.append("Tool metrics appear after the agent or Telecom Services panel executes a backend tool.")
    if not latencies:
        missing.append("Average response latency is unavailable until a tool call or timed agent reply is recorded.")
    if not ended:
        missing.append("Session resolution rate is unavailable until a voice session completes.")
    return missing
