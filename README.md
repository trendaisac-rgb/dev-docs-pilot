# dev-docs-pilot

A documentation Q&A agent over the Anthropic developer docs (`platform.claude.com/docs`).
Built as a qualification project for the Cloud Employee **Senior AI Builder** role.

Ask a question, watch the agent classify intent, search the indexed docs, re-rank
the hits with an LLM-as-judge, and stream back a grounded answer with citations —
every step visible in a live **Agent Trace** and inspectable down to the raw chunks.

---

## Repo layout

This is a monorepo with two coherent halves:

- **`./` (root)** — the product: a TanStack Start + React 19 + Tailwind frontend
  (scaffolded with Lovable, then iterated on) **and** the deployed runtime, a
  Supabase Edge Function under `supabase/functions/chat/`.
- **`api/`** — the Python side: the **ingestion pipeline** that populates pgvector,
  the **evaluation harness** (LLM-as-judge, persisted to Supabase), and a
  **reference implementation** of the agent built on the Claude Agent SDK.

The deployed runtime is the Edge Function. The `api/` package mirrors the same
retrieval + agent logic in Python — it's where ingestion and evaluation actually
run, and where the Claude Agent SDK ("Managed Agent") version of the loop lives.
Both share the same tool contract, prompts, and anti-hallucination rules.

---

## Architecture

```
Browser — TanStack Start / React 19
   │  POST {SUPABASE_URL}/functions/v1/chat
   │  SSE: meta · tool_use · tool_result · token · sources · done
   ▼
Supabase Edge Function  "chat"  (Deno/TS)            ◄── deployed runtime
   ├── intent classifier            claude-haiku-4-5  (answer / clarify / out-of-scope)
   └── tool-use loop                claude-sonnet-4-6
         ├── search_knowledge_base
         │     ├── embed query      OpenAI text-embedding-3-small
         │     ├── pgvector         match_documents RPC (Supabase)
         │     └── rerank           LLM-as-judge, claude-haiku-4-5
         └── format_citations       registers the Sources panel
   ▼
Streamed answer  +  Agent Trace  +  Retrieval Inspector  +  Sources panel

/evals route ──► Supabase eval_runs / eval_results  (PostgREST, anon read-only)
```

The frontend talks to the Edge Function directly — there is no separate API server
to run. `src/lib/config.ts` points at the deployed function; the Settings sheet can
repoint it to a local `supabase functions serve` during development.

---

## Quick start

### Run the frontend

```bash
bun install
bun run dev          # → http://localhost:5173
```

It works out of the box against the deployed Edge Function — no local backend
needed. Open `/` to chat, `/evals` for the evaluation dashboard.

### Reproduce ingestion + eval (`api/`)

```bash
cd api
cp .env.example .env   # ANTHROPIC_API_KEY, OPENAI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
uv sync

# Schema is already applied to the assessment's Supabase project. For a fresh
# project, run api/supabase/schema.sql in the Supabase SQL editor first.

uv run docs-agent-ingest                 # crawl → chunk → embed → write to pgvector
uv run python -m eval.run_eval           # 15-question eval → report + Supabase eval_runs
```

### Deploy the Edge Function

```bash
supabase functions deploy chat --no-verify-jwt --project-ref <project-ref>
# Secrets: ANTHROPIC_API_KEY, OPENAI_API_KEY
# (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are injected automatically.)
```

---

## What's where

### Frontend + runtime (root)

| Path | Purpose |
|---|---|
| `supabase/functions/chat/index.ts` | **The deployed runtime** — intent classifier, retrieval, LLM-as-judge rerank, tool-use loop, SSE server, all in one Deno module |
| `src/routes/index.tsx` | Chat route |
| `src/routes/evals.tsx` | Evaluation dashboard — reads Supabase `eval_runs` / `eval_results` |
| `src/components/ChatApp.tsx` | Top-level chat orchestration + SSE handling |
| `src/components/AgentTrace.tsx` | Live timeline of the agent's tool-use loop |
| `src/components/RetrievalInspector.tsx` | Per-search drill-down: chunks with vector similarity vs. judge relevance |
| `src/components/Sidebar.tsx` | Conversation history (rename / delete) + example questions |
| `src/components/MessageBubble.tsx` | Markdown rendering + inline citation badges |
| `src/components/SourcesPanel.tsx` | Right-rail structured citations |
| `src/lib/sse.ts` | Manual SSE parser over `fetch` + `ReadableStream` (EventSource can't POST) |
| `src/lib/evals.ts` | PostgREST client for the eval dashboard |
| `src/lib/config.ts` | Supabase URL + public anon key |

### Python side (`api/`)

| Path | Purpose |
|---|---|
| `api/src/docs_agent/ingest/` | `llms.txt`-aware ingestion (BFS HTML crawler fallback) |
| `api/src/docs_agent/retrieval/` | pgvector search + LLM-as-judge reranker (reference) |
| `api/src/docs_agent/agent/` | Claude Agent SDK runner + MCP-style tools — the "Managed Agent" reference |
| `api/src/docs_agent/api/` | FastAPI app exposing the reference agent locally |
| `api/eval/` | 15 Q/A dataset + retrieval metrics + LLM judge + report renderer |
| `api/supabase/schema.sql` | pgvector + HNSW + `match_documents` RPC |
| `api/scripts/insert_chunks_local.py` | Bulk-load pre-chunked data via PostgREST |

See **`api/README.md`** for the deeper write-up of the design decisions.

---

## Design highlights

### Why two implementations?

The deployed runtime is a Deno Edge Function — Supabase's native serverless model,
the same pattern used in production at MAVRYX Assistant. The Claude Agent SDK has no
mature Deno build, so the Edge Function hand-rolls the tool-use loop against the
Messages API. The Python `api/` package implements the *same* loop on the Claude
Agent SDK — the "Managed Agent" deep-dive — so the two can be compared directly.
Same tools, same prompts, same anti-hallucination rules; different runtime.

### Why `/llms.txt` ingestion?

`docs.anthropic.com` is a JS-rendered SPA — a plain HTTP crawler gets back
`"Loading…"` shells. The `/llms.txt` convention (Anthropic, Vercel, Stripe,
Cloudflare all publish one) is a markdown-friendly index of `.md` URLs. We use it
as the default ingest mode; the BFS HTML crawler is the fallback.

### LLM-as-judge reranker

Cosine similarity is a *relatedness* score, not a *sufficiency* score. A small judge
model (Haiku, ~$0.0001/call) does real semantic discrimination on the top-N vector
hits. It's skipped entirely when the top hit is already above
`KB_HIGH_CONFIDENCE_SIM` (0.78) — it fires on the murky middle, where retrieval
failures cluster. The Retrieval Inspector in the UI surfaces both scores side by side.

### Anti-hallucination prompting (AH-1..AH-6)

Evolved from running RAG in production. The most important rule: **never list what
you think the docs cover, only what retrieval actually returned.** Without it,
models confidently fabricate plausible-sounding feature lists.

---

## Eval

Latest run — `anthropic-docs-v2` dataset, 15 questions, agent `claude-sonnet-4-6`,
judge `claude-haiku-4-5` (2026-05-13). Reproduce with `cd api && uv run python -m eval.run_eval`;
results persist to Supabase `eval_runs` / `eval_results` and are browsable live at
the in-app `/evals` dashboard.

| Metric | Score |
|---|---|
| Precision@5 (retrieval) | 0.360 |
| Recall@5 (retrieval) | 0.600 |
| MRR (retrieval) | 0.593 |
| Faithfulness (judge) | 0.735 |
| Completeness (judge) | 0.913 |
| Citation correctness | 0.629 |

**Reading these honestly.** Faithfulness (0.73) and completeness (0.91) are the
headline answer-quality numbers — answers stay grounded in the retrieved chunks and
cover what's asked. Retrieval is the weak axis: Precision@5 0.36 / Recall@5 0.60 means
the right doc is usually *found* but sits among noise, which drags citation correctness
down to 0.63. The eval also carries a strict binary hallucination flag per question —
a per-question smoke alarm rather than a headline metric; its rationale is browsable in
the `/evals` dashboard. Top of the roadmap: tighten retrieval precision with hybrid
search (better chunking + a stronger rerank threshold).

---

## License

MIT.
