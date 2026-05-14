# Loom outline — 8 minute target

> The role is client-facing. Treat this like a 1:1 with a senior engineer at a
> client. Not a code walkthrough — a *decisions* walkthrough.

---

## 0:00 — 0:45 · Intro (45 sec)

- "Hi, I'm Doug — a senior AI builder shipping Anthropic-stack agents in
  production. Currently building **MAVRYX Assistant**, a regulatory-compliance RAG
  agent for the nicotine and cosmetics industries."
- "For this assessment I built a documentation Q&A agent over the Anthropic
  developer docs. I'll walk you through what I built, the decisions I made under
  the time budget, and what I'd do next."
- (Show the deployed app open in the browser, clean.)

## 0:45 — 2:15 · The demo (90 sec)

- "Quick demo first, then I'll back into the architecture."
- Ask a real question (Q02 from the eval — streaming the Messages API in Python).
- Point at the **Agent Trace** as it runs: "You're watching the agent think —
  it classifies the question, decides what to search for, and you can see it
  re-search if the first hit is weak."
- Expand the **Retrieval Inspector** on the search step: "These are the actual
  chunks it retrieved — vector similarity on the left, the LLM-as-judge relevance
  on the right. That split is the whole point, and I'll come back to it."
- Point at the streamed answer: inline citations link to the real docs URLs, and
  the Sources panel is built from what retrieval actually returned.
- Open `/evals`: "And this is the evaluation dashboard — live, reading from
  Supabase. I'll come back to this too."

## 2:15 — 4:15 · The two decisions that matter most (2 min)

### The reranker

- "The single thing that separates a demo RAG from a production RAG is the
  reranker. Cosine similarity is a *relatedness* score, not a *sufficiency* score —
  a chunk can score 0.7 for a question it answers and a question it just shares
  vocabulary with."
- "A small judge model — Haiku, ~$0.0001 a call — does real semantic
  discrimination on the top-N hits. It's the single biggest quality lift I've
  measured in production."
- Show the `KB_HIGH_CONFIDENCE_SIM` shortcut: "We skip the judge on the happy
  path — it only fires in the murky middle, which is where retrieval failures
  actually cluster." Tie it back to the Retrieval Inspector from the demo.

### The anti-hallucination prompt

- "AH-1 through AH-6 are rules I've evolved running RAG in production. The most
  important is AH-2 — never list what you *think* the docs cover, only what
  retrieval actually returned. Without it, models confidently invent
  plausible-sounding feature lists."
- "The never-empty rule means every turn either answers, asks one specific
  clarifier, or explicitly acknowledges the gap. No silent failures."

## 4:15 — 6:15 · The eval (2 min — the differentiator)

- "Anyone can wire up RAG. The interesting question is whether it actually works —
  so I built an eval harness and I'm honest about what it says."
- Walk the `/evals` dashboard: "15 questions across four categories. I measure
  retrieval *and* answer quality separately — precision@5, recall@5, MRR on
  retrieval; faithfulness, completeness, citation-correctness, and a strict binary
  hallucination flag on the answer, judged by Haiku."
- "Per-axis matters because an aggregate score hides the failure mode. Here
  completeness is 0.91 — answers cover the question. But precision@5 is 0.36: the
  right doc is usually found, but buried in noise, which drags citation
  correctness down."
- **Be honest about the 1.00 hallucination rate**: "That number looks alarming,
  and I want to address it head-on. The judge flags *any* detail not verbatim in a
  fairly thin ground-truth set — even when the detail came straight from a
  retrieved chunk. Expand any row and you can read the judge's rationale. It's a
  judge-calibration problem, not the agent fabricating — and fixing it is item two
  on my roadmap. I'd rather show you a strict, honest eval than a flattering one."

## 6:15 — 7:15 · Tradeoffs I'd want you to push back on (60 sec)

- **Two runtimes, on purpose.** "The deployed runtime is a Supabase Edge Function
  that hand-rolls the tool-use loop — Deno has no mature Agent SDK. The Python
  `api/` package implements the same loop on the Claude Agent SDK. Same tools, same
  prompts — I wanted to show both the managed and the raw version."
- **OpenAI embeddings, not Voyage.** "Voyage is Anthropic's recommendation. I chose
  OpenAI because the pgvector column is already sized for it and the time budget
  was tight. The migration is one column change plus a re-embed."
- **Retrieval precision is the known weak spot.** "0.36 precision@5. The fix is
  hybrid search — Postgres full-text alongside pgvector, RRF'd together — to close
  the exact-API-name gap pure embeddings have. That's roadmap item one."

## 7:15 — 8:00 · What I'd build next (45 sec)

Pick the three most interesting from the roadmap:

1. **Hybrid search** (full-text + pgvector, RRF) — the direct fix for low
   precision@5.
2. **Calibrate the judge** — richer ground-truth answers, a less binary
   hallucination axis.
3. **MCP server variant** — extract the tool contract into a standalone MCP server
   so any Claude client connects. Same code, different entrypoint — the
   assessment's Option C without rebuilding.

## 8:00 — close · Wrap (10 sec)

- "Repo's in the email — code, both READMEs, the eval dashboard. Happy to dive
  deeper on the reranker, the prompts, or the eval design. Thanks for the read."

---

## Keep even if tight

- The vector-similarity-vs-judge-relevance split in the Retrieval Inspector. It's
  the clearest single proof you understand retrieval.
- The honest read of the hallucination rate. Owning a bad-looking number with a
  precise explanation reads as senior; hiding it reads as junior.
- The explicit tradeoffs section. Shows opinions, not just code.

## On-screen checklist

- [ ] Camera on, decent lighting, no notifications visible
- [ ] Browser zoom readable; app on a clean conversation
- [ ] One real question working before recording (don't debug live)
- [ ] `/evals` dashboard loaded and a row pre-expanded
- [ ] Repo on a clean commit
