"""Smoke tests for the chunker — boundary cases that have bitten us before."""

from __future__ import annotations

from docs_agent.ingest.chunker import MAX_TOKENS, chunk_markdown


def test_empty_input_returns_no_chunks():
    assert chunk_markdown("") == []
    assert chunk_markdown("\n\n\n") == []


def test_no_headings_treated_as_one_section():
    md = "This is a paragraph.\n\nAnother paragraph.\n\nA third."
    chunks = chunk_markdown(md)
    assert len(chunks) == 1
    assert chunks[0].section == ""
    assert chunks[0].anchor == ""


def test_h2_boundaries_create_separate_chunks():
    md = (
        "Preamble paragraph.\n\n"
        "## First section\n\n"
        "Some content for the first section.\n\n"
        "## Second section\n\n"
        "Different content here.\n"
    )
    chunks = chunk_markdown(md)
    sections = [c.section for c in chunks]
    assert "First section" in sections
    assert "Second section" in sections


def test_anchor_is_url_safe():
    md = "## Hello, World! (v2.0)\n\nBody text here."
    chunks = chunk_markdown(md)
    assert chunks, "expected at least one chunk"
    anchor = chunks[0].anchor
    assert " " not in anchor
    assert "!" not in anchor
    assert "(" not in anchor


def test_oversized_section_splits_into_multiple_chunks():
    # ~2000 tokens of paragraphs
    body = "\n\n".join("This is paragraph " + str(i) + ". " * 30 for i in range(60))
    md = f"## Big section\n\n{body}"
    chunks = chunk_markdown(md)
    assert len(chunks) >= 2
    for c in chunks:
        assert c.token_count <= MAX_TOKENS + 100  # allow small overshoot on code blocks


def test_chunks_preserve_section_metadata():
    md = "## API Reference\n\nContent here describes the API."
    chunks = chunk_markdown(md)
    assert chunks[0].section == "API Reference"
    assert chunks[0].anchor == "api-reference"
