"""LLM-as-judge reranker.

Why this exists (this is the lesson from running RAG in production):
cosine similarity is a *relatedness* score, not a *sufficiency* score.
A chunk about "TPD packaging rules" gets ~0.7 similarity for both:

  - "Are fruit flavours banned in UK?"  (chunk has the answer)
  - "What's in TPD3?"                   (chunk doesn't)

This reranker takes the top vector hits and asks Claude Haiku to do
real semantic discrimination: does this chunk actually contain a
specific, on-point answer? Cheap (~$0.0001/call, ~300ms) and the single
biggest quality lift in our Mavryx production data.

Strategy:
- For chunks already above `kb_high_confidence_sim`, skip the judge.
- For everything else, run the judge in a single call (not per-chunk —
  much cheaper, and the judge benefits from seeing all candidates at
  once for relative ranking).
- Failure-mode is fail-open: a transient API hiccup returns the
  pre-rerank order unchanged. We never silently drop chunks.
"""

from __future__ import annotations

import json

from anthropic import AsyncAnthropic

from docs_agent.config import get_settings
from docs_agent.retrieval.types import RetrievedChunk

_JUDGE_SYSTEM = """You evaluate whether retrieved knowledge-base chunks contain a specific, on-point answer to a user's question.

# Rules (be strict)
- "Sufficient" means the chunk contains a SPECIFIC answer to the SPECIFIC question.
- "Mentions related acronyms or topics" is NOT sufficient.
- "Talks about an adjacent topic but not the question" is NOT sufficient.
- "Has a partial answer that doesn't cover the core ask" is NOT sufficient.
- If the question asks about feature X and the chunk describes feature Y, NOT sufficient.

# Output
Reply with ONLY a JSON object:
{
  "chunks": [
    {"index": 0, "sufficient": true,  "relevance": 0.95, "reason": "<one sentence>"},
    {"index": 1, "sufficient": false, "relevance": 0.30, "reason": "<one sentence>"},
    ...
  ],
  "any_sufficient": true
}

`index` matches the chunk index in the input. `relevance` is your 0..1 estimate.
No commentary outside the JSON. No markdown."""

_client: AsyncAnthropic | None = None


def _get_anthropic() -> AsyncAnthropic:
    global _client
    if _client is None:
        _client = AsyncAnthropic(api_key=get_settings().anthropic_api_key)
    return _client


async def rerank(
    query: str,
    chunks: list[RetrievedChunk],
    *,
    max_to_judge: int = 6,
    chunk_char_limit: int = 700,
) -> tuple[list[RetrievedChunk], bool]:
    """Rerank chunks by semantic sufficiency. Returns (sorted_chunks, any_sufficient).

    The boolean is a signal upstream callers can use (e.g. "if nothing
    is sufficient, switch to a clarify response instead of confabulating").
    """
    if not chunks:
        return [], False

    settings = get_settings()

    # Short-circuit: top chunk already above high-confidence threshold.
    # Saves a judge call + ~300ms on the happy path.
    if chunks[0].similarity >= settings.kb_high_confidence_sim:
        return chunks, True

    judging = chunks[:max_to_judge]
    summary = "\n\n---\n\n".join(
        f"[Chunk {i}] {c.citation_label()}\n{c.content[:chunk_char_limit]}"
        for i, c in enumerate(judging)
    )

    try:
        res = await _get_anthropic().messages.create(
            model=settings.anthropic_judge_model,
            max_tokens=600,
            temperature=0,
            system=_JUDGE_SYSTEM,
            messages=[
                {
                    "role": "user",
                    "content": f"QUESTION:\n{query}\n\nRETRIEVED CHUNKS:\n{summary}",
                }
            ],
        )
        raw_text = res.content[0].text if res.content else "{}"
        # Strip code-fences if the model added any
        raw_text = raw_text.strip().removeprefix("```json").removeprefix("```").removesuffix("```")
        parsed = json.loads(raw_text)
    except Exception as e:
        # Fail-open: log + return pre-rerank order
        print(f"[reranker] fail-open after error: {e}")
        return chunks, True

    # Build a re-scored list preserving the un-judged tail (if any).
    judgments = {int(j["index"]): j for j in parsed.get("chunks", [])}
    rescored: list[tuple[float, RetrievedChunk]] = []
    for i, c in enumerate(judging):
        j = judgments.get(i)
        if j and "relevance" in j:
            # Blend judge relevance with vector similarity. 0.7/0.3 in
            # favour of judge — vector sim already used to surface the
            # candidates; judge has the final say on ordering.
            blended = 0.7 * float(j["relevance"]) + 0.3 * c.similarity
        else:
            blended = c.similarity
        rescored.append((blended, c))

    rescored.sort(key=lambda x: x[0], reverse=True)
    sorted_judged = [c for _, c in rescored]

    # Append any chunks we didn't judge at the tail, preserving original order.
    tail = chunks[max_to_judge:]
    out = sorted_judged + tail

    return out, bool(parsed.get("any_sufficient", True))
