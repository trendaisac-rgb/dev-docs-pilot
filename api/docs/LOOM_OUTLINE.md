# Loom outline — 8 minute target

> The role is client-facing. Treat this like a 1:1 with a senior engineer at a client. Not a code walkthrough — a *decisions* walkthrough.

---

## 0:00 — 0:45 · Intro (45 sec)

- "Hi, I'm Doug. I'm a senior AI builder — I've been shipping Anthropic-stack agents in production over the last year. Currently building **MAVRYX Assistant**, a regulatory compliance RAG agent for the nicotine and cosmetics industries, in Phase 1 of a Round-1 launch."
- "For this assessment I built a documentation Q&A agent over `docs.anthropic.com`. I'm going to walk you through what I built, the decisions I made under the 4–6 hour budget, and what I'd do differently with more time."
- (Show repo on screen with a clean tree view: README open, file tree visible.)

## 0:45 — 2:00 · The demo (75 sec)

- "Quick demo first, then I'll back into the architecture."
- Run the API: `uv run uvicorn docs_agent.api.main:app`
- In a terminal, hit `/ask` with a real question (Q02 from the eval — Messages API streaming): show the JSON response.
- Open the SSE-streamed `/chat` endpoint in a browser tab using a curl + tee trick **or** a tiny HTML test page (`docs/demo.html`).
- Point out: (a) inline citations link to the real docs URLs, (b) the Sources block at the end, (c) the agent calls `search_knowledge_base` **before** answering — visible in the tool_use event.

## 2:00 — 4:00 · The two design decisions that matter most (2 min)

### The reranker

- "I want to call out the **single thing** that separates a demo RAG from a production RAG: the reranker."
- Open `src/docs_agent/retrieval/reranker.py`. Read the docstring out loud — the "TPD" example explains it cleanly without jargon.
- "Cosine similarity is a relatedness score, not a sufficiency score. A small judge model — I'm using Haiku — does real semantic discrimination at $0.0001 per call. It's the single biggest quality lift I've measured in production."
- Show the `KB_HIGH_CONFIDENCE_SIM` shortcut: "We skip the judge on the happy path. It only fires when we're in the murky middle, which is where retrieval failures actually cluster."

### The anti-hallucination prompt

- Open `src/docs_agent/agent/system_prompt.py`.
- "AH-1 through AH-6 are rules I've evolved running RAG in production. The most important: AH-2 — **never list what you think the docs cover, only what retrieval actually returned**. Models will happily say 'I have info on Python, TypeScript and Java' when only one of those was indexed."
- "The never-empty rule means every response either answers, asks one specific clarifier, or explicitly acknowledges the gap. No silent failures."

## 4:00 — 6:00 · The eval (2 min — this is the differentiator)

- "Anyone can wire up RAG. The interesting question is whether it actually works."
- Open `eval/run_eval.py` briefly, then `eval/judge.py`.
- "I'm measuring **both** retrieval-level and answer-level quality:
  - **Retrieval**: precision@5, recall@5, MRR — measured against ground-truth citation URLs.
  - **Answer**: four axes, judged independently by Haiku — **faithfulness**, **completeness**, **citation correctness**, **hallucination** (binary, strict).
- "Per-axis matters because aggregate scores hide the failure mode. If `faithfulness` drops I know the prompt is leaking. If `completeness` drops I know retrieval is missing answers. If `citation_correctness` drops I know the model is citing real URLs but for wrong claims."
- (Briefly show the per-question failure analysis section in a sample report — even a screenshot is fine.)
- "The dataset has 15 questions across four categories — factual-lookup, how-to, concept, edge-case — designed to stress different parts of the pipeline. The edge-case question is specifically designed to tempt the model with training knowledge; that's where AH-2 earns its keep."

## 6:00 — 7:15 · Tradeoffs I'd want you to push back on (75 sec)

Three explicit calls — show I have my own opinions:

1. **OpenAI embeddings, not Voyage.** "Voyage is Anthropic's official recommendation. I chose OpenAI because the pgvector column is already sized for it and I had 4–6 hours. The migration is one column change + a re-embed run — if your evaluator wants to see Voyage, that's a one-hour follow-up."
2. **Service-role key instead of JWT.** "RLS is enabled but I bypass it for the assessment. The pattern for wiring JWT auth is in our Mavryx Edge Function — 30 minutes to add."
3. **In-process session dict, not Redis.** "Works for one process. For horizontal scale I'd swap in Redis + transcript replay. Documented in the README as the production move."

## 7:15 — 8:00 · What I'd build next (45 sec)

Pick the **three** from the README list that an interviewer would find most interesting:

1. **Hybrid search** (BM25 + RRF) — closes the exact-API-name gap pure embeddings have.
2. **Eval CI** — 5-question sanity on every PR, full 15 nightly, metrics in `eval_runs` for trend tracking.
3. **MCP server variant** — same tools.py code, exposed as a standalone MCP server. Anything Claude can connect — Cowork, Desktop, Cursor — gets the same agent. That's the assessment's Option C without rebuilding.

## 8:00 — close · Wrap (10 sec)

- "Repo's in the email. Code, README, eval results, plus a 1-page Loom transcript. Happy to dive deeper on anything — the reranker, the prompts, or the eval design. Thanks for the read."

---

## Cuts and reshoots

Things to **cut** if you go over 8 min:

- The healthz endpoint demo. Skip.
- Reading the file tree out loud. Show, don't narrate.
- Apologising for "this is just a scaffold." Don't.

Things to **keep** even if tight:

- The TPD example in the reranker section. It lands.
- The "per-axis scores hide nothing" pitch. That's your eval credibility.
- The explicit tradeoffs section. Shows you have opinions, not just code.

## On-screen checklist

- [ ] Camera on, decent lighting, no notifications visible
- [ ] Terminal font readable (16pt+)
- [ ] Editor in a clean theme — no ghost branches, no "1 file changed"
- [ ] Repo on a clean commit
- [ ] One real API call working before recording (don't debug live)
- [ ] Eval report screenshot ready (or pre-run a small subset)
