"""OpenAI embeddings client.

Tradeoff note: Voyage `voyage-3-large` is Anthropic's official
recommendation for production RAG with Claude. We're using OpenAI here
because (a) it's what we already validated in production at Mavryx and
(b) it ships in 30 minutes vs. 2 hours of integration. The
1536-dimension column in pgvector is sized for `text-embedding-3-small`
specifically — swapping providers means a schema migration, so the
decision is intentional, not accidental.
"""

from __future__ import annotations

import asyncio
from collections.abc import Sequence

from openai import AsyncOpenAI

from docs_agent.config import get_settings

_client: AsyncOpenAI | None = None


def _get_openai() -> AsyncOpenAI:
    global _client
    if _client is None:
        _client = AsyncOpenAI(api_key=get_settings().openai_api_key)
    return _client


async def embed_one(text: str) -> list[float]:
    """Embed a single string. Use for query-time embedding."""
    s = get_settings()
    res = await _get_openai().embeddings.create(model=s.embed_model, input=text)
    return res.data[0].embedding


async def embed_batch(texts: Sequence[str], batch_size: int = 96) -> list[list[float]]:
    """Embed many strings, batched. OpenAI accepts up to 2048 per call,
    but smaller batches give better throughput when paired with concurrent
    requests + saner retry semantics if something fails mid-batch.
    """
    if not texts:
        return []

    s = get_settings()
    client = _get_openai()
    out: list[list[float]] = []

    async def _embed_one_batch(batch: Sequence[str]) -> list[list[float]]:
        res = await client.embeddings.create(model=s.embed_model, input=list(batch))
        return [d.embedding for d in res.data]

    # Sequential batches — bumping to concurrent gather() is a one-line
    # win once we know rate limits hold. Left simple for clarity.
    for i in range(0, len(texts), batch_size):
        chunk = texts[i : i + batch_size]
        out.extend(await _embed_one_batch(chunk))
        # Tiny breather to be polite to the API at high QPS
        if i + batch_size < len(texts):
            await asyncio.sleep(0.05)

    return out
