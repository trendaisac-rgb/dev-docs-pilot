"""Centralized config — env vars in one place, validated via pydantic-settings.

Why this pattern: keeps env-var typos from leaking into runtime, and makes the
expected interface explicit for anyone reviewing the repo.
"""

from __future__ import annotations

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # ── Anthropic ────────────────────────────────────────────────────
    anthropic_api_key: str = Field(..., alias="ANTHROPIC_API_KEY")
    anthropic_agent_model: str = Field("claude-sonnet-4-6", alias="ANTHROPIC_AGENT_MODEL")
    anthropic_judge_model: str = Field("claude-haiku-4-5", alias="ANTHROPIC_JUDGE_MODEL")

    # ── OpenAI (embeddings) ──────────────────────────────────────────
    openai_api_key: str = Field(..., alias="OPENAI_API_KEY")
    embed_model: str = Field("text-embedding-3-small", alias="EMBED_MODEL")
    embed_dim: int = 1536  # matches text-embedding-3-small + pgvector column

    # ── Supabase ─────────────────────────────────────────────────────
    supabase_url: str = Field(..., alias="SUPABASE_URL")
    supabase_service_role_key: str = Field(..., alias="SUPABASE_SERVICE_ROLE_KEY")
    supabase_anon_key: str = Field("", alias="SUPABASE_ANON_KEY")

    # ── Retrieval ────────────────────────────────────────────────────
    rag_match_count: int = Field(8, alias="RAG_MATCH_COUNT")
    # Above this similarity we skip the LLM-as-judge reranker — the chunk
    # is already strong enough. Tuned against Mavryx production data.
    kb_high_confidence_sim: float = Field(0.78, alias="KB_HIGH_CONFIDENCE_SIM")

    # ── API ──────────────────────────────────────────────────────────
    api_host: str = Field("0.0.0.0", alias="API_HOST")
    api_port: int = Field(8000, alias="API_PORT")

    # ── Ingestion ────────────────────────────────────────────────────
    # docs.anthropic.com is the default target; override at CLI time.
    default_doc_family: str = "anthropic-docs"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Singleton-style accessor. lru_cache so callers don't re-parse .env."""
    return Settings()  # type: ignore[call-arg]
