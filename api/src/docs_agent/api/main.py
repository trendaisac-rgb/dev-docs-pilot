"""FastAPI app entrypoint.

Run locally:
    uv run uvicorn docs_agent.api.main:app --reload

Health: GET /healthz
Chat:   POST /chat (see routes.py)
"""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from docs_agent.api.routes import router


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Session registry lives on app state; created here so it survives
    # across requests within one process. See routes.py for usage.
    app.state.sessions = {}
    yield
    # On shutdown, close any live AgentRunner contexts.
    for runner in list(app.state.sessions.values()):
        try:
            await runner.__aexit__(None, None, None)
        except Exception:
            pass


app = FastAPI(
    title="docs-agent",
    description="RAG over Anthropic documentation with a Claude Managed Agent.",
    version="0.1.0",
    lifespan=lifespan,
)

# Permissive CORS — fine for the assessment. Tighten before any
# real deployment.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


app.include_router(router)
