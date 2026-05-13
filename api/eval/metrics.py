"""Retrieval metrics: precision@k, recall@k, MRR.

Why these three:
- precision@k: of the top-k chunks we surfaced, how many are correct?
  Measures "are we wasting context tokens?"
- recall@k: of the relevant chunks that exist, how many did we find?
  Measures "are we missing the answer entirely?"
- MRR: how high did the first correct result rank? Measures "is the
  agent likely to actually use the right source?"

A note on URL matching: we treat URLs as "relevant" if they share the
same path (anchors stripped). This is more lenient than exact match
and reflects that one doc page often has multiple chunks indexed.
"""

from __future__ import annotations

from urllib.parse import urldefrag, urlparse


def _normalize(url: str) -> str:
    """Strip anchor, normalise trailing slash, lowercase host."""
    base, _ = urldefrag(url)
    parsed = urlparse(base)
    path = parsed.path.rstrip("/")
    return f"{parsed.scheme}://{parsed.netloc.lower()}{path}"


def precision_at_k(retrieved: list[str], expected: list[str], k: int) -> float:
    if k <= 0:
        return 0.0
    top = [_normalize(u) for u in retrieved[:k]]
    exp = {_normalize(u) for u in expected}
    if not top:
        return 0.0
    hits = sum(1 for u in top if u in exp)
    return hits / k


def recall_at_k(retrieved: list[str], expected: list[str], k: int) -> float:
    if not expected:
        return 1.0  # vacuously satisfied — but be explicit in the dataset
    top = {_normalize(u) for u in retrieved[:k]}
    exp = {_normalize(u) for u in expected}
    hits = sum(1 for u in exp if u in top)
    return hits / len(exp)


def mean_reciprocal_rank(retrieved: list[str], expected: list[str]) -> float:
    exp = {_normalize(u) for u in expected}
    for i, u in enumerate(retrieved, start=1):
        if _normalize(u) in exp:
            return 1.0 / i
    return 0.0
