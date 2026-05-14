/**
 * Retrieval — embed query, run match_documents RPC, then LLM-as-judge rerank.
 *
 * The reranker is the single biggest quality lift in this pipeline. Cosine
 * similarity is a relatedness score, not a sufficiency score: a chunk about
 * "Messages API streaming" gets ~0.7 similarity for both "how do I stream?"
 * (has the answer) and "what's max_tokens?" (doesn't). A small judge model
 * (Haiku) discriminates real on-topic chunks from merely related ones at
 * ~$0.0001/call and ~300ms.
 *
 * Strategy:
 *   - For chunks already above KB_HIGH_CONFIDENCE_SIM, skip the judge.
 *   - Otherwise run the judge in ONE call across the top-N (cheaper, and
 *     the judge benefits from seeing candidates side-by-side).
 *   - Fail-open: a transient judge error returns the un-reranked order.
 *
 * Pattern from `supabase/functions/chat/retrieval.ts` + `evaluator.ts` in
 * the Mavryx Helpdesk repo, with the `vertical` filter swapped for
 * `doc_family`.
 */

import { SupabaseClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

export interface Chunk {
  id: number;
  content: string;
  similarity: number;
  url: string;
  title: string;
  section: string;
  anchor: string;
}

const EMBED_MODEL = Deno.env.get("EMBED_MODEL") ?? "text-embedding-3-small";
const JUDGE_MODEL = Deno.env.get("ANTHROPIC_JUDGE_MODEL") ?? "claude-haiku-4-5";
const KB_HIGH_CONFIDENCE_SIM = parseFloat(
  Deno.env.get("KB_HIGH_CONFIDENCE_SIM") ?? "0.78",
);

// ── Embedding ───────────────────────────────────────────────────────

export async function embedQuery(
  query: string,
  openai: OpenAI,
): Promise<number[]> {
  const res = await openai.embeddings.create({
    model: EMBED_MODEL,
    input: query,
  });
  return res.data[0].embedding;
}

// ── Vector search via match_documents RPC ───────────────────────────

export async function retrieveChunks(opts: {
  client: SupabaseClient;
  embedding: number[];
  matchCount: number;
  docFamily?: string;
}): Promise<Chunk[]> {
  const { client, embedding, matchCount, docFamily } = opts;

  const filter: Record<string, unknown> = {};
  if (docFamily) filter.doc_family = docFamily;

  const { data, error } = await client.rpc("match_documents", {
    query_embedding: embedding,
    match_count: matchCount,
    filter,
  });

  if (error) {
    console.error("match_documents error:", error);
    return [];
  }

  // Project metadata into typed Chunk fields.
  return ((data ?? []) as Array<{
    id: number;
    content: string;
    metadata: Record<string, string>;
    similarity: number;
  }>).map((row) => ({
    id: row.id,
    content: row.content,
    similarity: row.similarity,
    url: row.metadata?.url ?? "",
    title: row.metadata?.title ?? "(untitled)",
    section: row.metadata?.section ?? "",
    anchor: row.metadata?.anchor ?? "",
  }));
}

// ── LLM-as-judge reranker ───────────────────────────────────────────

const JUDGE_SYSTEM = `You evaluate whether retrieved knowledge-base chunks contain a specific, on-point answer to a user's question.

# Rules (be strict)
- "Sufficient" means the chunk contains a SPECIFIC answer to the SPECIFIC question.
- "Mentions related acronyms or topics" is NOT sufficient.
- "Talks about an adjacent topic" is NOT sufficient.
- "Has a partial answer that doesn't cover the core ask" is NOT sufficient.

# Output
Reply with ONLY a JSON object (no markdown fences, no commentary):
{
  "chunks": [
    {"index": 0, "sufficient": true,  "relevance": 0.95, "reason": "<one sentence>"},
    {"index": 1, "sufficient": false, "relevance": 0.30, "reason": "<one sentence>"}
  ],
  "any_sufficient": true
}

\`index\` matches the chunk index in the input. \`relevance\` is your 0..1 estimate.`;

export async function rerank(opts: {
  query: string;
  chunks: Chunk[];
  client: Anthropic;
  maxToJudge?: number;
  chunkCharLimit?: number;
}): Promise<{ chunks: Chunk[]; anySufficient: boolean }> {
  const { query, chunks, client } = opts;
  const maxToJudge = opts.maxToJudge ?? 6;
  const chunkCharLimit = opts.chunkCharLimit ?? 700;

  if (chunks.length === 0) return { chunks: [], anySufficient: false };

  // Short-circuit: top chunk already above high-confidence threshold.
  if (chunks[0].similarity >= KB_HIGH_CONFIDENCE_SIM) {
    return { chunks, anySufficient: true };
  }

  const judging = chunks.slice(0, maxToJudge);
  const summary = judging
    .map(
      (c, i) =>
        `[Chunk ${i}] ${c.title}${c.section ? ` › ${c.section}` : ""}\n${c.content.slice(0, chunkCharLimit)}`,
    )
    .join("\n\n---\n\n");

  try {
    const res = await client.messages.create({
      model: JUDGE_MODEL,
      max_tokens: 600,
      temperature: 0,
      system: JUDGE_SYSTEM,
      messages: [
        {
          role: "user",
          content: `QUESTION:\n${query}\n\nRETRIEVED CHUNKS:\n${summary}`,
        },
      ],
    });

    const text = res.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("")
      .trim()
      .replace(/^```json/i, "")
      .replace(/^```/, "")
      .replace(/```$/, "")
      .trim();

    const parsed = JSON.parse(text) as {
      chunks: Array<{ index: number; sufficient: boolean; relevance: number }>;
      any_sufficient: boolean;
    };

    const judgments = new Map(parsed.chunks.map((j) => [j.index, j]));
    const rescored: Array<[number, Chunk]> = judging.map((c, i) => {
      const j = judgments.get(i);
      if (j && typeof j.relevance === "number") {
        // Blend judge relevance with vector similarity. 0.7/0.3 in favour
        // of the judge — vector sim already surfaced the candidates;
        // the judge has the final say on ordering.
        const blended = 0.7 * j.relevance + 0.3 * c.similarity;
        return [blended, c];
      }
      return [c.similarity, c];
    });

    rescored.sort((a, b) => b[0] - a[0]);
    const sorted = rescored.map(([, c]) => c);

    // Append any chunks we didn't judge at the tail, original order.
    const tail = chunks.slice(maxToJudge);

    return {
      chunks: [...sorted, ...tail],
      anySufficient: parsed.any_sufficient !== false,
    };
  } catch (err) {
    // Fail-open: a transient API hiccup shouldn't silently drop chunks.
    console.warn("reranker failed, returning un-reranked order:", err);
    return { chunks, anySufficient: true };
  }
}

// ── Citation formatting ─────────────────────────────────────────────

export function chunkCitation(chunk: Chunk): {
  title: string;
  url: string;
  section: string;
} {
  const url = chunk.anchor ? `${chunk.url}#${chunk.anchor}` : chunk.url;
  return { title: chunk.title, url, section: chunk.section };
}
