"""Scraper for docs.anthropic.com (and any single-domain documentation site).

Design:
- BFS over same-host links, capped at MAX_PAGES.
- Respects robots.txt (best effort — see _check_robots).
- Filters out non-doc URLs (e.g. blog, careers, anchors-only).
- Renders HTML → Markdown so chunking is structure-aware.
- Stores raw HTML for forensic re-chunking if we change strategy later.

Why not Playwright: Anthropic docs are SSR'd MDX; the markup we need
is present without JS. Saves ~3 min of cold-start latency per crawl.
"""

from __future__ import annotations

import asyncio
import hashlib
import re
from collections import deque
from dataclasses import dataclass, field
from urllib.parse import urldefrag, urljoin, urlparse
from urllib.robotparser import RobotFileParser

import httpx
from bs4 import BeautifulSoup
from markdownify import markdownify as md
from rich.progress import Progress

DEFAULT_USER_AGENT = "docs-agent/0.1 (assessment crawler - contact: see repo)"
# Skip these path prefixes — not docs.
_SKIP_PATH_PATTERNS = (
    r"^/blog",
    r"^/careers",
    r"^/news",
    r"^/legal",
    r"^/privacy",
    r"^/policies",
    r"^/api/index",  # OAS spec — handled separately if needed
)
_SKIP_RE = re.compile("|".join(_SKIP_PATH_PATTERNS))


@dataclass
class Page:
    url: str
    title: str
    markdown: str
    raw_html: str
    content_hash: str = field(init=False)

    def __post_init__(self) -> None:
        self.content_hash = hashlib.sha256(self.markdown.encode("utf-8")).hexdigest()


class Scraper:
    def __init__(
        self,
        start_url: str,
        *,
        max_pages: int = 200,
        concurrency: int = 4,
        timeout: float = 20.0,
    ) -> None:
        self.start_url = start_url
        self.max_pages = max_pages
        self.concurrency = concurrency
        self.timeout = timeout

        parsed = urlparse(start_url)
        self.host = parsed.netloc
        self.scheme = parsed.scheme

        self._seen: set[str] = set()
        self._robots: RobotFileParser | None = None

    async def _check_robots(self, client: httpx.AsyncClient) -> None:
        """Best-effort robots.txt parsing. Fails open if unreachable."""
        try:
            res = await client.get(f"{self.scheme}://{self.host}/robots.txt")
            if res.status_code == 200:
                rp = RobotFileParser()
                rp.parse(res.text.splitlines())
                self._robots = rp
        except Exception:
            self._robots = None

    def _allowed(self, url: str) -> bool:
        if self._robots and not self._robots.can_fetch(DEFAULT_USER_AGENT, url):
            return False
        parsed = urlparse(url)
        if parsed.netloc != self.host:
            return False
        if _SKIP_RE.match(parsed.path or "/"):
            return False
        return parsed.path.startswith("/")

    def _extract_links(self, html: str, base: str) -> list[str]:
        soup = BeautifulSoup(html, "lxml")
        out: list[str] = []
        for a in soup.find_all("a", href=True):
            href = a["href"].strip()
            if not href or href.startswith(("mailto:", "tel:", "javascript:")):
                continue
            absolute, _ = urldefrag(urljoin(base, href))
            if self._allowed(absolute):
                out.append(absolute)
        return out

    def _to_markdown(self, html: str) -> tuple[str, str]:
        """Return (title, markdown). Strips nav, header, footer, sidebars
        so chunks aren't polluted with the same boilerplate on every page.
        """
        soup = BeautifulSoup(html, "lxml")

        title_tag = soup.find("title")
        title = title_tag.text.strip() if title_tag else "(untitled)"

        # Heuristic content selectors — try main → article → fallback to body.
        body = soup.find("main") or soup.find("article") or soup.body or soup
        # Drop obvious chrome
        for sel in ("nav", "header", "footer", "aside", "[role='navigation']"):
            for el in body.select(sel):
                el.decompose()

        markdown = md(str(body), heading_style="ATX").strip()
        # Collapse 3+ blank lines that markdownify sometimes emits
        markdown = re.sub(r"\n{3,}", "\n\n", markdown)
        return title, markdown

    async def _fetch(self, client: httpx.AsyncClient, url: str) -> Page | None:
        try:
            res = await client.get(url, follow_redirects=True)
        except httpx.HTTPError as e:
            print(f"  ! fetch failed for {url}: {e}")
            return None
        if res.status_code != 200 or "text/html" not in res.headers.get("content-type", ""):
            return None
        try:
            title, markdown = self._to_markdown(res.text)
        except Exception as e:
            print(f"  ! parse failed for {url}: {e}")
            return None
        if len(markdown.strip()) < 200:
            # Probably a redirect-stub or empty index. Skip.
            return None
        return Page(url=url, title=title, markdown=markdown, raw_html=res.text)

    async def crawl(self) -> list[Page]:
        """BFS crawl, yielding fetched Pages. Respects max_pages."""
        results: list[Page] = []
        queue: deque[str] = deque([self.start_url])
        self._seen.add(self.start_url)

        async with httpx.AsyncClient(
            headers={"User-Agent": DEFAULT_USER_AGENT},
            timeout=self.timeout,
            limits=httpx.Limits(max_connections=self.concurrency * 2),
        ) as client:
            await self._check_robots(client)

            with Progress(transient=True) as progress:
                task = progress.add_task("Crawling…", total=self.max_pages)

                while queue and len(results) < self.max_pages:
                    batch: list[str] = []
                    while queue and len(batch) < self.concurrency:
                        batch.append(queue.popleft())

                    fetched = await asyncio.gather(
                        *(self._fetch(client, u) for u in batch),
                        return_exceptions=False,
                    )

                    for url, page in zip(batch, fetched, strict=True):
                        if page is None:
                            continue
                        results.append(page)
                        progress.update(task, advance=1)

                        for link in self._extract_links(page.raw_html, url):
                            if link not in self._seen and len(self._seen) < self.max_pages * 3:
                                self._seen.add(link)
                                queue.append(link)

                        if len(results) >= self.max_pages:
                            break

        return results
