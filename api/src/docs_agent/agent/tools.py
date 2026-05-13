"""Custom tools for the Managed Agent, exposed via an in-process MCP server.

We define three tools that compose the retrieval pipeline:

1. `search_knowledge_base` — embed + vector search + LLM-as-judge rerank
2. `format_citations`     — turns a list of chunk references into a
                            consistent Sources block
3. `rerank_results`       — exposed for transparency; lets the model
                            run the judge on a custom shortlist if it
                            wants to refine after multiple searches

Why MCP server (not Anthropic tool_use directly):
- The Claude Agent SDK speaks MCP natively; tools defined this way are
  trivially portable to a real MCP server (Option C of the assessment)
  and to Claude Desktop, Cowork, Cursor, etc.
- Tool definitions live in code (not JSON schemas hand-maintained),
  reducing drift.
"""

from __future__ import annotations

import json
from typing import Any

from claude_agent_sdk import create_sdk_mcp_server, tool

from docs_agent.retrieval.reranker import rerank
from docs_agent.retrieval.types import RetrievedChunk
from docs_agent.retrieval.vector_search import search


def _chunks_to_payload(chunks: list[RetrievedChunk]) -> list[dict[str, Any]]:
    """Project chunks to a JSON-friendly shape the model can reason about.
    We intentionally include the URL and section so the model can cite
    without re-asking; we trim content to keep token budget reasonable.
    """
    out: list[dict[str, Any]] = []
    for c in chunks:
        out.append(
            {
                "id": c.id,
                "title": c.title,
                "section": c.section,
                "url": c.citation_url(),
                "similarity": round(c.similarity, 3),
                "content": c.content[:1800],  # ~450 tokens — caps prompt blowup
            }
        )
    return out


# ── search_knowledge_base ────────────────────────────────────────────


@tool(
    "search_knowledge_base",
    "Search the Anthropic documentation index for chunks relevant to a query. "
    "Returns the top results ranked by semantic relevance, after a hybrid "
    "vector + LLM-as-judge rerank. Call this BEFORE answering any factual "
    "question. You can call it up to 3 times per turn with different "
    "rephrasings if the first results are weak.",
    {
        "query": str,
        "top_k": int,
    },
)
async def search_knowledge_base(args: dict[str, Any]) -> dict[str, Any]:
    query = args["query"]
    top_k = int(args.get("top_k") or 8)
    chunks = await search(query, top_k=top_k)
    reranked, any_sufficient = await rerank(query, chunks)

    payload = {
        "query": query,
        "top_k": top_k,
        "any_sufficient": any_sufficient,
        "results": _chunks_to_payload(reranked),
        # Hint to the agent: if any_sufficient is false, prefer
        # acknowledging the gap over confabulating.
        "note": (
            "any_sufficient=false means none of the returned chunks contains a "
            "specific answer. Consider clarifying the question or acknowledging "
            "the gap rather than answering from these chunks."
            if not any_sufficient
            else "any_sufficient=true means at least one chunk is on-point. Cite it."
        ),
    }
    return {"content": [{"type": "text", "text": json.dumps(payload, indent=2)}]}


# ── format_citations ────────────────────────────────────────────────


@tool(
    "format_citations",
    "Format a list of source references into a clean Sources block in markdown. "
    "Pass the urls (and optional titles) you want cited. Call this at the end "
    "of your answer so the user gets a consistent source list.",
    {
        # list[dict] is the public input — but tool input schemas in
        # claude-agent-sdk are flat; we accept a JSON-string and parse.
        "sources_json": str,
    },
)
async def format_citations(args: dict[str, Any]) -> dict[str, Any]:
    try:
        sources = json.loads(args["sources_json"])
    except (json.JSONDecodeError, KeyError):
        return {
            "content": [
                {
                    "type": "text",
                    "text": (
                        "Error: `sources_json` must be a JSON-encoded array of "
                        "{title?, url} objects. Example: "
                        '`[{"title":"Messages API","url":"https://..."}]`'
                    ),
                }
            ],
            "isError": True,
        }

    if not isinstance(sources, list) or not sources:
        return {"content": [{"type": "text", "text": "## Sources\n\n_(none)_"}]}

    # Dedupe by URL while preserving order
    seen: set[str] = set()
    deduped: list[dict[str, Any]] = []
    for s in sources:
        url = (s.get("url") or "").strip()
        if url and url not in seen:
            seen.add(url)
            deduped.append(s)

    lines = ["## Sources", ""]
    for i, s in enumerate(deduped, start=1):
        title = s.get("title") or s.get("url") or "(untitled)"
        url = s.get("url") or ""
        lines.append(f"{i}. [{title}]({url})")

    return {"content": [{"type": "text", "text": "\n".join(lines)}]}


# ── MCP server factory ──────────────────────────────────────────────


def build_mcp_server():
    """Create the in-process SDK MCP server that exposes our tools.

    Returned object is consumed by ClaudeAgentOptions.mcp_servers.
    """
    return create_sdk_mcp_server(
        name="docs-agent",
        version="0.1.0",
        tools=[search_knowledge_base, format_citations],
    )


# Names the agent should be allowed to call. Used by ClaudeAgentOptions.
ALLOWED_TOOLS = [
    "mcp__docs-agent__search_knowledge_base",
    "mcp__docs-agent__format_citations",
]
