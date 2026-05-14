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

# OpenAI text-embedding-3-* models cap input at 8192 tokens. We truncate
# at 8000 tokens (192-token headroom) using the real tokenizer because
# char-based heuristics underestimate on dense markdown tables and code
# (some chunks hit ~3 chars/token). Oversized chunks come from edge cases
# the section-aware chunker can't split (e.g. a giant table). Truncation
# is a safety net; the production fix is a table-aware chunker.
_EMBED_MAX_TOKENS = 8000
_EMBED_FALLBACK_MAX_CHARS = 24000  # if tiktoken is unavailable, fall back

# Lazy-load tiktoken — air-gapped envs may not have CDN access for the
# encoder file. We degrade gracefully to char-based truncation.
try:
    import tiktoken

    _ENCODER = tiktoken.encoding_for_model("text-embedding-3-small")

    def _truncate_to_tokens(text: str, max_tokens: int) -> tuple[str, bool]:
        tokens = _ENCODER.encode(text)
        if len(tokens) <= max_tokens:
            return text, False
        return _ENCODER.decode(tokens[:max_tokens]), True

except Exception:  # noqa: BLE001
    _ENCODER = None

    def _truncate_to_tokens(text: str, max_tokens: int) -> tuple[str, bool]:
        # Char-based fallback. 3 chars/token is the conservative lower bound
        # we've observed on dense tables — safer than the 4:1 rule of thumb.
        safe_chars = max_tokens * 3
        if len(text) <= safe_chars:
            return text, False
        return text[:safe_chars], True


_client: AsyncOpenAI | None = None


def _get_openai() -> AsyncOpenAI:
    global _client
    if _client is None:
        _client = AsyncOpenAI(api_key=get_settings().openai_api_key)
    return _client


async def embed_one(text: str) -> list[float]:
    """Embed a single string. Use for query-time embedding."""
    s = get_settings()
    safe, _ = _truncate_to_tokens(text, _EMBED_MAX_TOKENS)
    res = await _get_openai().embeddings.create(model=s.embed_model, input=safe)
    return res.data[0].embedding


async def embed_batch(texts: Sequence[str], batch_size: int = 96) -> list[list[float]]:
    """Embed many strings, batched. OpenAI accepts up to 2048 inputs per
    call, but smaller batches give better throughput when paired with
    concurrent requests + saner retry semantics if something fails mid-batch.

    Each text is truncated to fit OpenAI's 8192-token input cap using the
    real tokenizer (tiktoken). Falls back to char-based truncation in
    air-gapped environments where tiktoken can't fetch its encoder.
    """
    if not texts:
        return []

    s = get_settings()
    client = _get_openai()
    out: list[list[float]] = []

    # Pre-truncate, count how many needed it, warn once.
    safe_texts: list[str] = []
    n_truncated = 0
    for t in texts:
        safe, was_truncated = _truncate_to_tokens(t, _EMBED_MAX_TOKENS)
        if was_truncated:
            n_truncated += 1
        safe_texts.append(safe)
    if n_truncated:
        method = "tiktoken" if _ENCODER is not None else "char-fallback"
        print(
            f"  ⚠ {n_truncated} chunk(s) truncated to {_EMBED_MAX_TOKENS} "
            f"tokens via {method}."
        )

    async def _embed_one_batch(batch: Sequence[str]) -> list[list[float]]:
        res = await client.embeddings.create(model=s.embed_model, input=list(batch))
        return [d.embedding for d in res.data]

    # Sequential batches — bumping to concurrent gather() is a one-line
    # win once we know rate limits hold. Left simple for clarity.
    for i in range(0, len(safe_texts), batch_size):
        chunk = safe_texts[i : i + batch_size]
        out.extend(await _embed_one_batch(chunk))
        # Tiny breather to be polite to the API at high QPS
        if i + batch_size < len(safe_texts):
            await asyncio.sleep(0.05)

    return out
