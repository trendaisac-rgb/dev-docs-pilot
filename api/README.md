# docs-agent

A RAG agent that answers questions over [docs.anthropic.com](https://docs.anthropic.com) using a Claude Managed Agent, pgvector, and an LLM-as-judge evaluation harness.

Built as a qualification project for the Cloud Employee **Senior AI Builder** role. Scope was 4–6 hours; the design decisions reflect that budget — every choice has a "why this not that" called out below.

---

## TL;DR

```text
User question
    │
    ▼
FastAPI  ── POST /chat (SSE)  ──►  AgentRunner (Claude Agent SDK, claude-sonnet-4-6)
                                        │
                                        ├── tool: search_knowledge_base
                                        │     ├── embed query (OpenAI text-embedding-3-small)
                                        │     ├── pgvector match_documents RPC
                                        │     └── LLM-as-judge rerank (claude-haiku-4-5)
                                        │
                                        └── tool: format_citations
                                              └── deterministic Sources block
    │
    ▼
Streaming markdown answer with inline + structured citations
```

- **Production-grade RAG patterns**: vector search + semantic reranker, anti-hallucination prompting, never-empty rule, citation discipline.
- **Managed Agent via Claude Agent SDK** with custom MCP tools — same pattern works as a real MCP server (Option C of the assessment) without rewriting.
- **Real eval framework**: 15 Q/A pairs over Anthropic docs, retrieval metrics (precision@k, recall@k, MRR) **and** answer quality scored on four independent axes by Claude Haiku as a judge.

---

## Quick start

```bash
# 1. Install
uv sync

# 2. Configure
cp .env.example .env
# Fill in: ANTHROPIC_API_KEY, OPENAI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

# 3. Bootstrap the database (run once in your Supabase SQL editor — or apply schema.sql)
#    The schema has already been applied to the assessment's Supabase project (sources, documents,
#    eval_runs, eval_results tables; pgvector + HNSW + match_documents RPC + bulk_insert_documents).

# 4. Ingest the docs (uses the /llms.txt convention — see "Design decisions" below)
uv run docs-agent-ingest

# 5. Run the API
uv run uvicorn docs_agent.api.main:app --reload

# 6. Ask it something
curl -X POST http://localhost:8000/ask \
  -H "Content-Type: application/json" \
  -d '{"question": "How do I stream a response from the Messages API in Python?"}'

# 7. Run the eval
uv run python -m eval.run_eval
```

The eval writes `eval/runs/<timestamp>/report.md` and persists aggregate metrics to Supabase (`eval_runs` / `eval_results`).

---

## Architecture

### Layers

```
src/docs_agent/
├── config.py            # pydantic-settings — single source of truth for env
├── db.py                # supabase client factory
├── embeddings.py        # OpenAI embeddings (batched, async)
│
├── ingest/              # Crawl → chunk → embed → write
│   ├── scraper.py         BFS crawl, robots-aware, HTML → Markdown
│   ├── chunker.py         Section-aware chunking (H2/H3 boundaries + overlap)
│   └── main.py            CLI (typer)
│
├── retrieval/           # The bit that matters most for quality
│   ├── vector_search.py   pgvector via match_documents RPC
│   ├── reranker.py        LLM-as-judge rerank (single call over top-N)
│   └── types.py           RetrievedChunk pydantic model
│
├── agent/               # Claude Agent SDK plumbing
│   ├── tools.py           search_knowledge_base + format_citations as MCP tools
│   ├── system_prompt.py   anti-hallucination rules (AH-1..AH-6) + never-empty
│   └── runner.py          Session-aware wrapper with typed event stream
│
└── api/
    ├── main.py            FastAPI app + lifespan + CORS
    └── routes.py          POST /chat (SSE) + POST /ask (JSON) + DELETE /session
```

### Data flow (one turn)

1. **Client** posts `{question, session_id?}` to `/chat`.
2. **API** finds or creates an `AgentRunner` keyed by `session_id` and held in-process.
3. **Agent (Claude Sonnet 4.5)** reads the system prompt, decides to call `search_knowledge_base`.
4. **Tool**: embed query → `match_documents` RPC → rerank with Haiku → return JSON payload of chunks with similarity scores + `any_sufficient` flag.
5. **Agent** composes an answer using *only* the returned chunks, with inline `[Title › Section](url)` citations.
6. **Agent** calls `format_citations` for the final Sources block.
7. **API** streams the response tokens + tool calls back as SSE.

---

## Design decisions (and what I'd defend)

### 0. Why /llms.txt instead of a BFS HTML crawler?

Modern docs sites (Anthropic's included) are server-rendered SPAs that ship "Loading..." shells in HTML — a pure httpx crawler gets back useless markup. The fix is the `/llms.txt` convention: many docs sites (Anthropic, Vercel, Stripe, Cloudflare) now publish an index of `.md` URLs designed for LLM consumption. We use that as the default ingestion mode. The BFS HTML crawler is kept as a fallback for sites without `/llms.txt` (`--mode crawl`). The `.md` URLs are also the site owner's canonical URLs for citations — which is exactly what we want.

### 1. Why a section-aware chunker, not fixed sliding window?

Retrieval quality is dominated by **chunk coherence**, not chunk length. Splitting on H2/H3 boundaries keeps semantic units intact — a "Streaming the API response" section ends up as one chunk, not three. Fixed windows fragment that and force the reranker to do reassembly work.

For sections that exceed `MAX_TOKENS` we fall back to paragraph-boundary splits with a small overlap. Code blocks stay whole — fragmenting them breaks syntax-aware retrieval (a user searching for `client.messages.create(stream=True)` should get a chunk that contains the full pattern, not the line above it).

### 2. Why an LLM-as-judge reranker, not BM25 + RRF?

The biggest single lesson from running RAG in production: **cosine similarity is a relatedness score, not a sufficiency score.** A chunk about "TPD packaging rules" gets ~0.7 similarity for both:

- "Are fruit flavours banned in UK?" → has the answer
- "What's in TPD3?" → doesn't

BM25 + reciprocal rank fusion improves recall but doesn't fix this. A small judge model (Haiku, ~$0.0001/call, ~300ms) does. The reranker takes the top-N vector hits and returns a sufficiency score per chunk plus an `any_sufficient` boolean — which the agent uses to decide between answering and acknowledging the gap.

**The high-confidence shortcut**: if the top vector hit is already above `KB_HIGH_CONFIDENCE_SIM` (0.78), we skip the judge entirely. That's the happy path. The judge fires on the murky middle, which is where retrieval failures cluster.

### 3. Why a Managed Agent with custom MCP tools, not a hand-rolled tool-use loop?

Three reasons:

- **Session management is free.** `ClaudeSDKClient` keeps conversation state for the lifetime of the context manager. For multi-turn Q&A that's 80% of the plumbing handled.
- **MCP tools are portable.** The two tools defined in `agent/tools.py` are trivially exposable as a standalone MCP server (Option C of the assessment) without a rewrite.
- **Signals fluency in the Anthropic stack** — which is what the role is testing for.

The tradeoff: the SDK adds a dependency and a layer of abstraction. For an evaluator who wants to see "raw" tool-use code, I can swap in a 50-line manual loop using `anthropic.Anthropic().messages.create(tools=[...])` without touching anything else in the pipeline.

### 4. Why OpenAI embeddings instead of Voyage?

Voyage (`voyage-3-large`) is Anthropic's official recommendation. I went with OpenAI `text-embedding-3-small` because:

- The pgvector column dimensionality (1536) matches OpenAI directly — Voyage's 1024-dim model would need a schema migration.
- This is the exact stack I run in production at Mavryx Assistant, so the chunker, prompts, and reranker are already tuned for it.
- 4–6 hour scope: shipping > marginal quality gain.

**The migration is one column change + a re-embed run.** If the eval shows retrieval underperforming on technical jargon (Voyage handles code/API terms better in my experience), the swap path is documented in `embeddings.py`.

### 5. Why per-axis judge scores instead of a single "quality" number?

A composite score of 0.62 tells you nothing useful. Per-axis lets us point at the failure mode:

- `faithfulness` drops → prompt is letting the model invent. Revisit AH-1..AH-6.
- `completeness` drops → retriever is missing answers. Look at recall@k.
- `citation_correctness` drops → the model is citing real URLs but for the wrong claims. Tool description needs tightening.
- `hallucination` (binary, strict) → smoke alarm. Single failure here matters more than 0.1 on faithfulness.

The four axes map directly to the anti-hallucination rules in the system prompt, so a regression on `faithfulness` immediately tells me where to look.

### 6. Why service-role key in the API instead of JWT auth?

The assessment doesn't ask for an auth layer, and adding one would burn an hour I'd rather spend on eval quality. The schema enables RLS by default (no permissive policies = anon/auth see nothing, service role bypasses). Wiring JWT in is a 30-minute job once an auth model is decided — pattern is in our Mavryx Edge Function.

---

## Eval

The eval harness (`eval/run_eval.py`) is the part I'd want a reviewer to spend the most time on. It runs end-to-end:

1. For each item in `eval/dataset.json`:
   - Run direct retrieval (vector search only) → score precision@5, recall@5, MRR
   - Run the full agent → capture answer, latency, tool-call count
   - Send `{question, ground_truth, expected_urls, answer}` to Claude Haiku as judge
   - Get back 4 scores: faithfulness, completeness, citation_correctness, hallucination (binary)
2. Aggregate, sort by composite failure score, write a Markdown report
3. Persist to `eval_runs` + `eval_results` in Supabase so we can watch metrics move as we tune

### Example aggregate output

```
| Metric                    | Score |
|---------------------------|-------|
| Precision@5 (retrieval)   | ?.??? |
| Recall@5 (retrieval)      | ?.??? |
| MRR (retrieval)           | ?.??? |
| Faithfulness (judge)      | ?.??? |
| Completeness (judge)      | ?.??? |
| Citation correctness      | ?.??? |
| Hallucination rate        | ?.??? |
| Avg latency (ms)          | ?     |
| Avg tool calls / turn     | ?.??  |
```

Run `uv run python -m eval.run_eval` and check `eval/runs/<timestamp>/report.md` for per-question failure analysis.

### Why these 15 questions?

The dataset covers four categories — `factual-lookup`, `how-to`, `concept`, `edge-case` — chosen to stress different parts of the pipeline:

- **factual-lookup** (Q01, Q04, Q08, Q10, Q14, Q15): tests precise retrieval of single facts. Reranker matters most here.
- **how-to** (Q02, Q07, Q09, Q11, Q12): tests whether the agent extracts code patterns cleanly without paraphrasing them away.
- **concept** (Q03, Q05): tests cross-section synthesis — answers span multiple chunks.
- **edge-case** (Q13): tests anti-hallucination under pressure. The docs may not have a clean answer, and the model has tempting training knowledge.

If the eval shows weak `completeness` on `concept` questions, the fix is bumping `RAG_MATCH_COUNT` and/or asking the agent to issue follow-up searches. If `faithfulness` drops on `factual-lookup`, the system prompt is losing the AH-2 rule — that's the regression I'd watch for first.

---

## What I'd build next (day one of the job)

In rough priority order:

1. **Hybrid search** — add Postgres full-text alongside pgvector, RRF the two. Closes the "exact-token-match" gap that pure embedding retrieval has on API names and parameter names.
2. **Voyage embeddings + re-embed** — measure delta on the eval. If `recall@5` jumps meaningfully on technical jargon, migrate.
3. **Persistent sessions** — replace the in-process dict with Redis + transcript replay so the API can scale horizontally.
4. **Streaming the tool-use phase too** — currently the user waits silently while `search_knowledge_base` runs. Emitting an SSE `tool_use` event with a UI hint (`"Searching the docs..."`) is a 10-minute UX win.
5. **Multi-query rewriting in the search tool** — for vague questions, generate 2–3 reformulations in one judge call and union the results. Lifts recall without an extra round-trip.
6. **Eval CI** — run a 5-question sanity subset on every PR; full 15 nightly. Track metrics in `eval_runs` so regressions are visible immediately.
7. **MCP server variant** — extract `tools.py` into a standalone MCP server so any Claude client (Claude Desktop, Cowork, Cursor) can connect. Same code, different entrypoint.

---

## Stack

| Layer | Choice | Why |
|---|---|---|
| Agent runtime | [`claude-agent-sdk`](https://docs.anthropic.com/en/api/agent-sdk/overview) | Native MCP + session management |
| Agent model | `claude-sonnet-4-6` | Best reasoning/cost tradeoff for tool-use loops |
| Judge model | `claude-haiku-4-5` | Cheap, fast, accurate enough for binary sufficiency calls |
| Embeddings | OpenAI `text-embedding-3-small` | Pragmatic; Voyage is the prod upgrade |
| Vector DB | Supabase + pgvector (HNSW) | Same stack as the role's production env |
| API | FastAPI + sse-starlette | Async, type-safe, streaming-friendly |
| CLI | Typer + Rich | Nice ergonomics, low cost |
| Lint/format | Ruff | One tool, fast |
| Python | 3.11+ via uv | Modern, deterministic installs |

---

## References

- [Anthropic — Claude Agent SDK](https://docs.anthropic.com/en/api/agent-sdk/overview)
- [Anthropic — Tool use overview](https://docs.anthropic.com/en/docs/build-with-claude/tool-use/overview)
- [Anthropic — Prompt caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)
- [Supabase — pgvector guide](https://supabase.com/docs/guides/ai)
- [Model Context Protocol](https://modelcontextprotocol.io)

---

## License

MIT.
