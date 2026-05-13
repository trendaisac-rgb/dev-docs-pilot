"""HTTP routes.

POST /chat:
  Streams a Server-Sent Events response. Events:
    event: meta        — { session_id }
    event: tool_use    — { tool, input }
    event: token       — { token }
    event: done        — {}
    event: error       — { message }

POST /ask:
  Non-streaming variant for the eval script and simple integrations.
  Returns the final answer and the list of citations as JSON.

Session model:
  - If the client supplies session_id, we reuse the AgentRunner kept
    in app.state.sessions. Otherwise we create one.
  - Sessions are per-process. For multi-instance deployments, swap
    this dict for Redis-backed persistence + a transcript replay
    mechanism (documented in the README).
"""

from __future__ import annotations

import json
import uuid
from collections.abc import AsyncIterator
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from docs_agent.agent.runner import AgentRunner

router = APIRouter()


class ChatRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=4000)
    session_id: str | None = None


class AskResponse(BaseModel):
    session_id: str
    answer: str
    citations: list[dict[str, Any]]
    tool_calls: int


async def _get_or_create_session(app_state: Any, session_id: str | None) -> tuple[str, AgentRunner]:
    sid = session_id or str(uuid.uuid4())
    sessions: dict[str, AgentRunner] = app_state.sessions
    runner = sessions.get(sid)
    if runner is None:
        runner = await AgentRunner().__aenter__()
        sessions[sid] = runner
    return sid, runner


# ── POST /chat (SSE streaming) ──────────────────────────────────────


@router.post("/chat")
async def chat(req: Request, body: ChatRequest):
    sid, runner = await _get_or_create_session(req.app.state, body.session_id)

    async def event_gen() -> AsyncIterator[dict[str, str]]:
        yield {"event": "meta", "data": json.dumps({"session_id": sid})}
        try:
            async for ev in runner.ask(body.question):
                if ev.kind == "text" and ev.text:
                    yield {"event": "token", "data": json.dumps({"token": ev.text})}
                elif ev.kind == "tool_use":
                    yield {
                        "event": "tool_use",
                        "data": json.dumps({"tool": ev.tool_name, "input": ev.tool_input or {}}),
                    }
                elif ev.kind == "done":
                    yield {"event": "done", "data": "{}"}
                    return
        except Exception as e:
            yield {"event": "error", "data": json.dumps({"message": str(e)})}
            yield {"event": "done", "data": "{}"}

    return EventSourceResponse(event_gen())


# ── POST /ask (non-streaming, for eval) ─────────────────────────────


@router.post("/ask", response_model=AskResponse)
async def ask(req: Request, body: ChatRequest) -> AskResponse:
    sid, runner = await _get_or_create_session(req.app.state, body.session_id)

    answer_parts: list[str] = []
    citations: list[dict[str, Any]] = []
    tool_calls = 0

    try:
        async for ev in runner.ask(body.question):
            if ev.kind == "text" and ev.text:
                answer_parts.append(ev.text)
            elif ev.kind == "tool_use":
                tool_calls += 1
                # Extract URLs from search_knowledge_base tool inputs/outputs
                # for the structured citation list. The agent also formats
                # them inline; this is the machine-readable copy.
                if ev.tool_name == "mcp__docs-agent__format_citations":
                    raw = (ev.tool_input or {}).get("sources_json", "[]")
                    try:
                        citations = json.loads(raw)
                    except json.JSONDecodeError:
                        pass
            elif ev.kind == "done":
                break
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e

    return AskResponse(
        session_id=sid,
        answer="".join(answer_parts),
        citations=citations,
        tool_calls=tool_calls,
    )


# ── DELETE /session/{id} ────────────────────────────────────────────


@router.delete("/session/{sid}")
async def delete_session(req: Request, sid: str) -> dict[str, str]:
    sessions: dict[str, AgentRunner] = req.app.state.sessions
    runner = sessions.pop(sid, None)
    if runner is None:
        return {"status": "not_found"}
    try:
        await runner.__aexit__(None, None, None)
    except Exception:
        pass
    return {"status": "closed"}
