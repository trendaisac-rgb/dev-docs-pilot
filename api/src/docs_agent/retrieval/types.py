"""Shared types for retrieval. Keeping them in one place so tools, API,
and eval all import from the same module — no shape drift.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class RetrievedChunk(BaseModel):
    """One result from match_documents. Carries everything the agent
    needs to answer with citations and the eval needs to score.
    """

    id: int
    content: str
    similarity: float = Field(..., ge=0.0, le=1.0)
    # Metadata is jsonb in the DB; we project the useful keys explicitly
    # so callers can do `chunk.url` instead of `chunk.metadata["url"]`.
    url: str
    title: str
    section: str = ""
    anchor: str = ""
    doc_family: str = ""
    raw_metadata: dict[str, Any] = Field(default_factory=dict)

    @classmethod
    def from_row(cls, row: dict[str, Any]) -> RetrievedChunk:
        md = row.get("metadata") or {}
        return cls(
            id=row["id"],
            content=row["content"],
            similarity=float(row["similarity"]),
            url=md.get("url", ""),
            title=md.get("title", ""),
            section=md.get("section", "") or "",
            anchor=md.get("anchor", "") or "",
            doc_family=md.get("doc_family", "") or "",
            raw_metadata=md,
        )

    def citation_label(self) -> str:
        """Short, human-friendly label for inline citations."""
        title = self.title or "(untitled)"
        if self.section:
            return f"{title} › {self.section}"
        return title

    def citation_url(self) -> str:
        """URL with anchor when available."""
        if self.anchor:
            return f"{self.url}#{self.anchor}"
        return self.url
