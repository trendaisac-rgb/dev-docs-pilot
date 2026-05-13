"""CLI for ingestion: crawl/fetch → chunk → embed → write to Supabase.

Two modes:
- `llms-txt` (recommended): parse a docs site's /llms.txt index and fetch
  the canonical .md URLs. Works on SPA-rendered docs sites because we
  bypass HTML entirely. Default for `docs.anthropic.com`.
- `crawl`: BFS HTML crawler. Use for sites without /llms.txt. Falls
  back to markdownify for HTML → MD conversion.

Usage:
    # Default — Anthropic docs via llms.txt
    uv run docs-agent-ingest

    # Override / scope to a section
    uv run docs-agent-ingest --filter "/api/" --max-pages 80

    # Use the BFS HTML crawler instead (for non-llms.txt sites)
    uv run docs-agent-ingest --mode crawl --start-url https://example.com/docs

    # Dry run — no DB writes
    uv run docs-agent-ingest --dry-run
"""

from __future__ import annotations

import asyncio
from typing import Any

import typer
from rich.console import Console

from docs_agent.config import get_settings
from docs_agent.db import get_client
from docs_agent.embeddings import embed_batch
from docs_agent.ingest.chunker import chunk_markdown
from docs_agent.ingest.llms_txt import KNOWN_INDEX_URLS, LlmsTxtIngester
from docs_agent.ingest.scraper import Scraper

app = typer.Typer(add_completion=False, no_args_is_help=False)
console = Console()


async def _ingest(
    *,
    mode: str,
    start_url: str,
    max_pages: int,
    doc_family: str,
    url_filter: str | None,
    dry_run: bool,
    skip_embeddings: bool,
) -> None:
    client = get_client() if not dry_run else None

    # ── Source pages ──
    if mode == "llms-txt":
        index_url = start_url
        if index_url in KNOWN_INDEX_URLS:  # name → URL convenience
            index_url = KNOWN_INDEX_URLS[index_url]
        console.print(f"[bold]Ingesting[/bold] via llms.txt: {index_url} (max {max_pages} pages)")
        ingester = LlmsTxtIngester(
            index_url=index_url,
            max_pages=max_pages,
            url_filter=url_filter,
        )
        pages = await ingester.ingest()
    elif mode == "crawl":
        console.print(f"[bold]Crawling[/bold] (BFS HTML): {start_url} (max {max_pages} pages)")
        scraper = Scraper(start_url=start_url, max_pages=max_pages)
        pages = await scraper.crawl()
    else:
        raise typer.BadParameter(f"Unknown mode: {mode}. Use 'llms-txt' or 'crawl'.")

    console.print(f"[green]✓[/green] Got {len(pages)} pages")

    # ── Dedupe + write sources ──
    source_id_by_url: dict[str, str | None] = {}
    if not dry_run and client is not None:
        for p in pages:
            res = (
                client.table("sources")
                .upsert(
                    {
                        "url": p.url,
                        "title": p.title,
                        "content_hash": p.content_hash,
                    },
                    on_conflict="url",
                )
                .execute()
            )
            source_id_by_url[p.url] = res.data[0]["id"] if res.data else None

    # ── Chunk ──
    all_chunks: list[tuple[Any, str, str, str]] = []  # (page, content, section, anchor)
    for p in pages:
        for chunk in chunk_markdown(p.markdown):
            all_chunks.append((p, chunk.content, chunk.section, chunk.anchor))

    console.print(f"[bold]Chunks:[/bold] {len(all_chunks)}")
    if not all_chunks:
        console.print("[red]No chunks produced — exiting.[/red]")
        return

    # ── Embed ──
    embeddings: list[list[float]] | list[None]
    if skip_embeddings:
        console.print(
            "[yellow]--skip-embeddings set — chunks will be written with NULL embedding.[/yellow]"
        )
        embeddings = [None] * len(all_chunks)
    else:
        console.print("[bold]Embedding…[/bold]")
        texts = [c[1] for c in all_chunks]
        embeddings = await embed_batch(texts)
        console.print(f"[green]✓[/green] Got {len(embeddings)} embeddings")

    if dry_run:
        console.print("[yellow]--dry-run set — skipping DB writes.[/yellow]")
        return

    assert client is not None
    console.print("[bold]Writing to Supabase…[/bold]")
    rows = []
    for (page, content, section, anchor), emb in zip(all_chunks, embeddings, strict=True):
        row: dict[str, Any] = {
            "source_id": source_id_by_url.get(page.url),
            "content": content,
            "metadata": {
                "doc_family": doc_family,
                "url": page.url,
                "title": page.title,
                "section": section,
                "anchor": anchor,
            },
        }
        if emb is not None:
            row["embedding"] = emb
        rows.append(row)

    BATCH = 100
    for i in range(0, len(rows), BATCH):
        batch = rows[i : i + BATCH]
        client.table("documents").insert(batch).execute()
        console.print(f"  wrote {min(i + BATCH, len(rows))}/{len(rows)}")

    console.print(f"[green]✓ Done.[/green] {len(rows)} chunks indexed.")


@app.command()
def main(
    mode: str = typer.Option(
        "llms-txt",
        "--mode",
        help="Ingestion mode: 'llms-txt' (default, uses /llms.txt index) or 'crawl' (BFS HTML).",
    ),
    start_url: str = typer.Option(
        "anthropic-docs",
        "--start-url",
        help=(
            "For llms-txt mode: either a known site name (anthropic-docs, claude-platform) "
            "or a full llms.txt URL. For crawl mode: the seed URL."
        ),
    ),
    max_pages: int = typer.Option(150, "--max-pages"),
    doc_family: str | None = typer.Option(
        None,
        "--doc-family",
        help="Metadata tag for retrieval filtering. Defaults to settings.",
    ),
    url_filter: str | None = typer.Option(
        None,
        "--filter",
        help="(llms-txt mode) Only include URLs containing this substring (e.g. '/api/').",
    ),
    dry_run: bool = typer.Option(False, "--dry-run", help="Skip DB writes."),
    skip_embeddings: bool = typer.Option(
        False,
        "--skip-embeddings",
        help=(
            "Skip the OpenAI embedding step — chunks are written with NULL embedding. "
            "Used for schema validation and offline testing."
        ),
    ),
) -> None:
    family = doc_family or get_settings().default_doc_family
    asyncio.run(
        _ingest(
            mode=mode,
            start_url=start_url,
            max_pages=max_pages,
            doc_family=family,
            url_filter=url_filter,
            dry_run=dry_run,
            skip_embeddings=skip_embeddings,
        )
    )


if __name__ == "__main__":
    app()
