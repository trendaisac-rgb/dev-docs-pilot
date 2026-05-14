"""
Insert all document chunks into Supabase from local JSON batches.

Run this locally with SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in env.
The MCP-based ingestion via the agent context is not feasible because the
execute_sql tool truncates query parameters above ~15KB. This script bypasses
that by calling the bulk_insert_documents RPC directly via HTTP.

Usage:
    export SUPABASE_URL=https://qonbpdqlkfsiosdkzjtf.supabase.co
    export SUPABASE_SERVICE_ROLE_KEY=<service_role_key>
    python scripts/insert_chunks_local.py
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

import httpx

BATCH_DIR = Path(__file__).resolve().parent.parent / ".ingest_cache" / "json_batches"


def main() -> int:
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        print("ERROR: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY", file=sys.stderr)
        return 1

    endpoint = f"{url.rstrip('/')}/rest/v1/rpc/bulk_insert_documents"
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }

    batch_files = sorted(BATCH_DIR.glob("batch_*.json"))
    if not batch_files:
        print(f"ERROR: no batch files in {BATCH_DIR}", file=sys.stderr)
        return 1

    total_inserted = 0
    with httpx.Client(timeout=60.0) as client:
        for bf in batch_files:
            with bf.open() as f:
                rows = json.load(f)
            t0 = time.time()
            resp = client.post(endpoint, headers=headers, json={"rows": rows})
            if resp.status_code >= 300:
                print(f"FAIL {bf.name}: {resp.status_code} {resp.text}", file=sys.stderr)
                return 1
            inserted = resp.json()
            if isinstance(inserted, list):
                inserted = inserted[0] if inserted else 0
            total_inserted += int(inserted)
            print(f"{bf.name}: inserted={inserted} (rows in file={len(rows)}) elapsed={time.time()-t0:.1f}s")

    print(f"\nTOTAL inserted: {total_inserted}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
