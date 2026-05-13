"""Vector search via the match_documents RPC.

Pattern lifted from Mavryx production: embed query → RPC with metadata
filter → return typed chunks. The RPC accepts a jsonb `filter` matched
via `@>`, so callers can scope to a doc_family without changing SQL.
"""

from __future__ import annotations

from docs_agent.config import get_settings
from docs_agent.db import get_client
from docs_agent.embeddings import embed_one
from docs_agent.retrieval.types import RetrievedChunk


async def search(
    query: str,
    *,
    top_k: int | None = None,
    doc_family: str | None = None,
) -> list[RetrievedChunk]:
    """Embed query and run match_documents RPC.

    Args:
        query: User question (or rewrite). Embedded fresh each call —
            cache layer can be added later; not in v1 to keep the
            critical path simple.
        top_k: Max chunks returned. Defaults to settings.rag_match_count.
        doc_family: Metadata filter — scopes search to a single corpus.
            Defaults to settings.default_doc_family.
    """
    settings = get_settings()
    k = top_k or settings.rag_match_count
    family = doc_family or settings.default_doc_family

    embedding = await embed_one(query)

    client = get_client()
    res = client.rpc(
        "match_documents",
        {
            "query_embedding": embedding,
            "match_count": k,
            "filter": {"doc_family": family},
        },
    ).execute()

    rows = res.data or []
    return [RetrievedChunk.from_row(r) for r in rows]
