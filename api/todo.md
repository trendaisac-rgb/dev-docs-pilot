# todo.md — docs-agent assessment

Workflow per workspace CLAUDE.md: plan → verify → track → document.

## Now (scaffold complete — your turn to fill the gaps)

- [ ] `cp .env.example .env` and fill real keys (Anthropic, OpenAI, Supabase)
- [ ] Apply `supabase/schema.sql` in the Supabase SQL editor
- [ ] Run `uv sync` to install deps
- [ ] `uv run docs-agent-ingest --start-url https://docs.anthropic.com/en/home --max-pages 150`
- [ ] Sanity check: `curl -X POST http://localhost:8000/ask -d '{"question":"..."}'`
- [ ] Run eval: `uv run python -m eval.run_eval`
- [ ] Tune `KB_HIGH_CONFIDENCE_SIM` and `RAG_MATCH_COUNT` based on eval results
- [ ] Re-run eval, capture aggregate scores into README "Eval results" section
- [ ] Sanity check on Loom: pre-record a 5-question subset so the demo never sits silently

## Loom

- [ ] Read `docs/LOOM_OUTLINE.md`
- [ ] Pre-stage: terminal font, clean repo, one working API call, eval screenshot
- [ ] Record. 8 min target. Re-record once if the first take rambles.

## Submission

- [ ] Push to a clean public repo named `cloud-employee-assessment` (or similar — NOT mavryx-flavoured)
- [ ] Verify README renders well on GitHub (admonition blocks, code fences)
- [ ] Verify the Loom is public/link-shared
- [ ] Reply to Alejandra with: repo URL + Loom URL + "what I'd build next" paragraph

## Review section (fill after submission)

- _What did I learn from this exercise?_
- _What would I change about the scaffold if I built this again?_
- _What lessons to add to `lessons.md`?_

## Stretch (only if time after eval)

- [ ] Hybrid search: add a Postgres FTS index + RRF merge in `vector_search.py`
- [ ] MCP server variant: extract `agent/tools.py` into a standalone MCP server (Option C demo)
- [ ] Streaming tool-use UX: emit a "Searching the docs…" hint when `search_knowledge_base` fires
