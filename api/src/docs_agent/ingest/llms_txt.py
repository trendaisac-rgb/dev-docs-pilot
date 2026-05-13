"""llms.txt-based ingestion.

The `/llms.txt` and `/llms-full.txt` convention is increasingly common
on docs sites that want to be LLM-friendly (Anthropic, Vercel, Stripe,
Cloudflare, etc.). The index lives at `/llms.txt`; each entry points
to a `.md` URL that serves raw Markdown.

Why prefer this over the HTML crawler:
- Many modern docs sites are SPAs that render content via JS — pure
  httpx gets back "Loading…" shells. The `.md` URLs serve real content
  no matter what.
- The index lists *the canonical URL* the site owners want indexed,
  which is exactly what we want for citations.
- Much faster than BFS — one request per page, no link-extraction.

The HTML crawler (`scraper.py`) is the fallback for sites without
`llms.txt`. Both produce the same `Page` shape, so downstream
chunking / embedding / write is identical.
"""

from __future__ import annotations

import asyncio
import hashlib
import re
from dataclasses import dataclass, field

import httpx
from rich.progress import Progress

DEFAULT_USER_AGENT = "docs-agent/0.1 (assessment crawler - contact: see repo)"


@dataclass
class Page:
    """Mirror of `scraper.Page` so downstream code doesn't care which
    ingestion mode produced the page.
    """

    url: str
    title: str
    markdown: str
    raw_html: str  # unused for llms.txt mode but kept for shape parity
    content_hash: str = field(init=False)

    def __post_init__(self) -> None:
        self.content_hash = hashlib.sha256(self.markdown.encode("utf-8")).hexdigest()


# Match: [Title](https://example.com/path.md)
_INDEX_LINK_RE = re.compile(r"\[([^\]]+)\]\((https?://[^\)\s]+\.md)\)")


def parse_llms_txt(index_text: str) -> list[tuple[str, str]]:
    """Extract `(title, url)` pairs from an llms.txt-style index.
    Dedupes by URL while preserving first-seen order.
    """
    seen: set[str] = set()
    out: list[tuple[str, str]] = []
    for m in _INDEX_LINK_RE.finditer(index_text):
        title, url = m.group(1).strip(), m.group(2).strip()
        if url not in seen:
            seen.add(url)
            out.append((title, url))
    return out


def _title_from_markdown(md: str, fallback: str) -> str:
    """Extract the first H1 from the markdown; fall back to provided title.
    Many `.md` payloads lead with `# Heading` — we prefer that over the
    index's link text because it's the page's self-declared title.
    """
    for line in md.splitlines():
        stripped = line.strip()
        if stripped.startswith("# "):
            return stripped[2:].strip()
        if stripped:
            break
    return fallback


class LlmsTxtIngester:
    def __init__(
        self,
        index_url: str,
        *,
        max_pages: int = 150,
        concurrency: int = 8,
        timeout: float = 30.0,
        url_filter: str | None = None,
    ) -> None:
        """Args:
        index_url: location of the llms.txt index file.
        max_pages: cap on .md pages fetched.
        concurrency: parallel page fetches. 8 is conservative for
            docs.anthropic.com; bump if you own the rate limit.
        url_filter: substring; only fetch URLs containing this.
            Use to scope to a section (e.g. "/api/", "/build-with-claude/").
        """
        self.index_url = index_url
        self.max_pages = max_pages
        self.concurrency = concurrency
        self.timeout = timeout
        self.url_filter = url_filter

    async def _fetch_index(self, client: httpx.AsyncClient) -> list[tuple[str, str]]:
        res = await client.get(self.index_url)
        res.raise_for_status()
        return parse_llms_txt(res.text)

    async def _fetch_page(
        self, client: httpx.AsyncClient, sem: asyncio.Semaphore, title: str, url: str
    ) -> Page | None:
        async with sem:
            try:
                res = await client.get(url, follow_redirects=True)
            except httpx.HTTPError as e:
                print(f"  ! fetch failed for {url}: {e}")
                return None
            if res.status_code != 200:
                return None
            markdown = res.text.strip()
            if len(markdown) < 200:
                return None
            real_title = _title_from_markdown(markdown, title)
            return Page(url=url, title=real_title, markdown=markdown, raw_html="")

    async def ingest(self) -> list[Page]:
        async with httpx.AsyncClient(
            headers={"User-Agent": DEFAULT_USER_AGENT},
            timeout=self.timeout,
            limits=httpx.Limits(max_connections=self.concurrency * 2),
        ) as client:
            entries = await self._fetch_index(client)
            if self.url_filter:
                entries = [e for e in entries if self.url_filter in e[1]]
            entries = entries[: self.max_pages]
            print(f"  Index: {len(entries)} URLs queued (after filter / cap)")

            sem = asyncio.Semaphore(self.concurrency)
            pages: list[Page] = []
            with Progress(transient=True) as progress:
                task = progress.add_task("Fetching pages…", total=len(entries))
                coros = [self._fetch_page(client, sem, t, u) for t, u in entries]
                for coro in asyncio.as_completed(coros):
                    p = await coro
                    progress.update(task, advance=1)
                    if p is not None:
                        pages.append(p)

        return pages


# Sensible default index URLs for well-known docs sites.
KNOWN_INDEX_URLS: dict[str, str] = {
    "anthropic-docs": "https://docs.anthropic.com/llms.txt",
    "claude-platform": "https://platform.claude.com/llms.txt",
}
