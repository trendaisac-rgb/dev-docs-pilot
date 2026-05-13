"""Supabase client factory.

Uses the service-role key so the API can read/write across all tables
without an end-user JWT. For a production deployment this would be
replaced with an auth-aware client + RLS policies (see Mavryx pattern).
"""

from __future__ import annotations

from functools import lru_cache

from docs_agent.config import get_settings
from supabase import Client, create_client


@lru_cache(maxsize=1)
def get_client() -> Client:
    s = get_settings()
    return create_client(s.supabase_url, s.supabase_service_role_key)
