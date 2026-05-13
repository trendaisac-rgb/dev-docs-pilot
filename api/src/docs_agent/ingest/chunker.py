"""Section-aware Markdown chunker.

Strategy (in priority order):
1. Split by H2/H3 headings → keeps semantic boundaries intact.
2. If a section exceeds MAX_TOKENS, split on paragraph boundaries with
   sliding-window overlap.
3. Each chunk inherits the URL + section anchor for citations.

Why not naive fixed-size sliding window:
- Retrieval quality is dominated by chunk coherence, not chunk length.
- Anthropic docs are heading-rich; we get clean semantic units for free.
- The reranker (LLM-as-judge) handles cases where context spans sections.

Token counts use tiktoken's `cl100k_base` — fine as an upper bound; the
actual model tokenizer doesn't have to match. We just need consistency.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# tiktoken is preferred for accurate counts, but it lazily fetches an
# encoder from a CDN on first use. Air-gapped/sandboxed environments
# (CI, offline dev) don't always have egress to that CDN. We fall
# back to a 4-chars-per-token heuristic — slightly conservative for
# English prose, accurate enough for chunk-budget decisions.
try:
    import tiktoken

    _ENCODER = tiktoken.get_encoding("cl100k_base")

    def _token_len(s: str) -> int:
        return len(_ENCODER.encode(s))

except Exception:
    _ENCODER = None  # type: ignore[assignment]

    def _token_len(s: str) -> int:
        # Conservative char→token approximation. Overcounts code/whitespace
        # slightly, which is the safe direction (smaller chunks).
        return max(1, len(s) // 4)


# Target chunk size. 512–1024 tokens with ~15% overlap is the band that
# consistently outperformed both shorter (200) and longer (1500) chunks
# in our Mavryx production benchmarks.
TARGET_TOKENS = 700
MAX_TOKENS = 1024
OVERLAP_TOKENS = 100

# Match H2 / H3 headings. We intentionally skip H1 (usually page title).
_HEADING_RE = re.compile(r"^(#{2,3})\s+(.+?)\s*$", re.MULTILINE)


@dataclass
class Chunk:
    content: str
    section: str  # Section heading text — empty if outside any section
    anchor: str  # URL-safe slug for jump-to-anchor citations
    token_count: int


def _slugify(text: str) -> str:
    slug = re.sub(r"[^\w\s-]", "", text.lower())
    slug = re.sub(r"\s+", "-", slug).strip("-")
    return slug[:80]


def _split_oversized(text: str, section: str, anchor: str) -> list[Chunk]:
    """Paragraph-aware split for sections that bust MAX_TOKENS."""
    paragraphs = re.split(r"\n\n+", text)
    chunks: list[Chunk] = []
    buf: list[str] = []
    buf_tokens = 0

    def flush(carry_tail: bool = False) -> None:
        nonlocal buf, buf_tokens
        if not buf:
            return
        joined = "\n\n".join(buf).strip()
        if joined:
            chunks.append(
                Chunk(
                    content=joined,
                    section=section,
                    anchor=anchor,
                    token_count=_token_len(joined),
                )
            )
        # Sliding-window overlap: keep the tail of this chunk as the
        # start of the next one. Improves retrieval on facts that
        # straddle paragraph boundaries.
        if carry_tail and buf:
            tail = buf[-1] if _token_len(buf[-1]) < OVERLAP_TOKENS * 2 else ""
            buf = [tail] if tail else []
            buf_tokens = _token_len(tail) if tail else 0
        else:
            buf = []
            buf_tokens = 0

    for para in paragraphs:
        ptokens = _token_len(para)
        # A single oversized paragraph (e.g. a code block): emit it
        # standalone — better one big chunk than aggressive sub-splits
        # that fragment code semantics.
        if ptokens > MAX_TOKENS:
            flush(carry_tail=False)
            chunks.append(Chunk(content=para, section=section, anchor=anchor, token_count=ptokens))
            continue

        if buf_tokens + ptokens > TARGET_TOKENS and buf_tokens > 0:
            flush(carry_tail=True)

        buf.append(para)
        buf_tokens += ptokens

    flush(carry_tail=False)
    return chunks


def chunk_markdown(markdown: str) -> list[Chunk]:
    """Top-level entry: split a page's markdown into citation-ready chunks."""
    chunks: list[Chunk] = []

    # Build (start_offset, heading, content) tuples by walking H2/H3 boundaries.
    matches = list(_HEADING_RE.finditer(markdown))
    if not matches:
        # No headings — treat the whole page as one section.
        if markdown.strip():
            chunks.extend(_split_oversized(markdown.strip(), section="", anchor=""))
        return chunks

    # Anything before the first heading is a "preamble" section.
    first_start = matches[0].start()
    preamble = markdown[:first_start].strip()
    if preamble:
        chunks.extend(_split_oversized(preamble, section="", anchor=""))

    for i, m in enumerate(matches):
        heading = m.group(2).strip()
        body_start = m.end()
        body_end = matches[i + 1].start() if i + 1 < len(matches) else len(markdown)
        section_text = markdown[body_start:body_end].strip()
        if not section_text:
            continue
        anchor = _slugify(heading)
        # If the section itself fits within MAX_TOKENS, emit as one chunk.
        # Otherwise split via paragraph-aware splitter.
        if _token_len(section_text) <= MAX_TOKENS:
            chunks.append(
                Chunk(
                    content=f"## {heading}\n\n{section_text}",
                    section=heading,
                    anchor=anchor,
                    token_count=_token_len(section_text),
                )
            )
        else:
            chunks.extend(_split_oversized(section_text, section=heading, anchor=anchor))

    return chunks
