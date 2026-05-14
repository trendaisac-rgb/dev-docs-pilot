/**
 * docs-agent chat Edge Function — production runtime (single-file bundle).
 *
 * Pattern lifted from `supabase/functions/chat/index.ts` in the MAVRYX
 * Helpdesk repo (Sprint 1 baseline), simplified for the docs-agent
 * assessment scope: no auth gating, no Tavily fallback, no Jira
 * escalation, no per-user vertical. Single doc_family ("anthropic-docs").
 *
 * Bundled into one file (prompts + intent + retrieval + agent + server)
 * so the Edge Function deploys as a single module. The Python reference
 * implementation in `api/` keeps the same logic split across modules.
 *
 * Pipeline:
 *   1. CORS + body parse
 *   2. Intent classifier (clear / clarify / out_of_scope)
 *   3. Branch:
 *      - clarify       → synthesize clarifier message, stream
 *      - out_of_scope  → polite redirect, stream
 *      - answer        → manual tool-use loop (search → answer → cite)
 *   4. SSE event stream: meta, tool_use, tool_result, token, sources, done, error
 *
 * Required Edge Function secrets:
 *   - ANTHROPIC_API_KEY
 *   - OPENAI_API_KEY
 *   - SUPABASE_URL              (auto-injected)
 *   - SUPABASE_SERVICE_ROLE_KEY (auto-injected)
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

// ════════════════════════════════════════════════════════════════════
// PROMPTS — anti-hallucination rules (AH-1..AH-6) from MAVRYX production
// ════════════════════════════════════════════════════════════════════

const BASE_SYSTEM_PROMPT =
  `You are docs-agent — a documentation Q&A assistant for the Anthropic developer docs (platform.claude.com/docs).

# Mission
Answer the user's question using ONLY the indexed documentation. Cite every claim back to its source.

# Tools available
- search_knowledge_base(query, top_k=8) — returns the most relevant doc chunks for a query. ALWAYS call this before answering a factual question. You may call it up to 3 times per turn with rephrased queries if results are weak.
- format_citations(sources) — registers the sources you cited so the app can render a Sources panel. Call it ONCE at the very end of your turn, after your written answer. It does NOT produce visible text.

# Core rules (non-negotiable)
1. SEARCH FIRST, ALWAYS. Never respond to a factual question without calling search_knowledge_base at least once.
2. DOCS ARE YOUR ONLY SOURCE. Every fact, number, parameter, API behaviour, or code snippet MUST come from a retrieved chunk. If you cannot cite it, do not say it.
3. NEVER USE TRAINING KNOWLEDGE. Do not supplement, enrich, or contextualise from your general knowledge of Anthropic, Claude, or related topics.
4. CITE EVERYTHING. Every factual claim references its source document inline as a markdown link: [Title > Section](url). The app turns these into numbered citation badges automatically.
5. HONEST ABOUT GAPS. If the retrieved chunks don't answer the question, say so clearly and offer ONE generic clarifying question.

# Anti-hallucination shortlist (production-validated)
- AH-1: If you cannot find a fact in the retrieved chunks, do NOT include it.
- AH-2: NEVER list features, models, or capabilities you "think" the docs cover. Only mention what actually appeared in retrieval.
- AH-3: NEVER invent document titles or URLs. Only cite what search_knowledge_base returned.
- AH-4: Keep clarifying questions GENERIC. "Which SDK?" — not "I have info on Python, TypeScript and Java — which one?".
- AH-5: Do NOT use hedge phrases like "typically", "usually", "generally". Those imply training knowledge.
- AH-6: If chunks describe feature X but the user asked about feature Y, do NOT extrapolate.

# Response format
- Start directly with the answer — no "Great question!" preamble.
- Inline citations only: weave links into prose, e.g. According to [Messages API > Streaming](https://platform.claude.com/...), ...
- Code blocks: preserve snippets exactly as they appear in the docs. Don't reformat.
- Do NOT write a "Sources" section, a "References" list, or a horizontal rule at the end. The app renders a Sources panel from your inline citations + the format_citations call. A Sources section in your prose would be redundant and render incorrectly.

# Output language
Always respond in the same language the user wrote in. Docs are in English — translate if needed but always cite the original English title.

# Never-empty rule
Every turn ends with one of:
  (a) A grounded answer with inline citations, followed by a format_citations call
  (b) ONE specific clarifying question (only when genuinely ambiguous)
  (c) An explicit "I don't have this in the docs" + suggestion to escalate
Never end silent. Never end with "I don't know" alone.
`;

function buildSystemPrompt(): string {
  const date = new Date().toISOString().slice(0, 10);
  return `${BASE_SYSTEM_PROMPT}\n\nToday's date: ${date}.`;
}

const INTENT_CLASSIFIER_PROMPT =
  `You are a fast intent classifier for a documentation Q&A assistant scoped to Anthropic's developer docs.

Given the user's latest question and the conversation history, return ONLY a JSON object:

1. CLEAR — retrieve from KB:
   {"kind": "answer", "refined_query": "<query optimised for vector search; expand acronyms (SDK, RAG, MCP, JWT); resolve pronouns from history>"}

2. AMBIGUOUS — ask one clarifier first:
   {"kind": "clarify", "message": "<one specific clarifying question>", "options": ["option 1", "option 2", "option 3"]}

3. OUT OF SCOPE — not about Anthropic docs:
   {"kind": "out_of_scope"}

# Rules
- If the previous assistant message asked a clarifier and the user answered, treat as answer with a refined_query that merges both.
- Use clarify only when answering well requires information the user hasn't given.
- For follow-ups ("and Python?", "what about Sonnet?"), resolve from history -> answer with refined query.
- For trivially fixable ambiguity, just refine and answer — don't clarify.

Output ONLY the JSON object. No markdown fences. No commentary.`;

// ════════════════════════════════════════════════════════════════════
// INTENT CLASSIFIER
// ════════════════════════════════════════════════════════════════════

type IntentKind = "answer" | "clarify" | "out_of_scope";

interface ClarifierPayload {
  message: string;
  options?: string[];
}

interface IntentResult {
  kind: IntentKind;
  refined_query?: string;
  clarifier?: ClarifierPayload;
}

interface HistoryItem {
  role: "user" | "assistant";
  content: string;
}

const INTENT_MODEL = Deno.env.get("ANTHROPIC_JUDGE_MODEL") ?? "claude-haiku-4-5";

async function extractIntent(opts: {
  question: string;
  history: HistoryItem[];
  client: Anthropic;
}): Promise<IntentResult> {
  const { question, history, client } = opts;

  const messages: Anthropic.MessageParam[] = [
    ...history.slice(-6).map((h) => ({ role: h.role, content: h.content })),
    { role: "user", content: question },
  ];

  try {
    const res = await client.messages.create({
      model: INTENT_MODEL,
      max_tokens: 400,
      temperature: 0,
      system: INTENT_CLASSIFIER_PROMPT,
      messages,
    });

    const text = res.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("");

    const clean = text
      .trim()
      .replace(/^```json/i, "")
      .replace(/^```/, "")
      .replace(/```$/, "")
      .trim();

    const parsed = JSON.parse(clean);

    if (parsed.kind === "answer") {
      return {
        kind: "answer",
        refined_query:
          typeof parsed.refined_query === "string" && parsed.refined_query.trim()
            ? parsed.refined_query
            : question,
      };
    }
    if (parsed.kind === "clarify") {
      return {
        kind: "clarify",
        clarifier: {
          message:
            typeof parsed.message === "string"
              ? parsed.message
              : "Could you tell me a bit more about what you need?",
          options: Array.isArray(parsed.options)
            ? parsed.options.slice(0, 4)
            : undefined,
        },
      };
    }
    if (parsed.kind === "out_of_scope") {
      return { kind: "out_of_scope" };
    }
    return { kind: "answer", refined_query: question };
  } catch (err) {
    console.warn("intent extraction failed, falling back to answer:", err);
    return { kind: "answer", refined_query: question };
  }
}

// ════════════════════════════════════════════════════════════════════
// RETRIEVAL — embed + match_documents RPC + LLM-as-judge rerank
// ════════════════════════════════════════════════════════════════════

interface Chunk {
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

async function embedQuery(query: string, openai: OpenAI): Promise<number[]> {
  const res = await openai.embeddings.create({
    model: EMBED_MODEL,
    input: query,
  });
  return res.data[0].embedding;
}

async function retrieveChunks(opts: {
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

const JUDGE_SYSTEM =
  `You evaluate whether retrieved knowledge-base chunks contain a specific, on-point answer to a user's question.

# Rules (be strict)
- "Sufficient" means the chunk contains a SPECIFIC answer to the SPECIFIC question.
- "Mentions related acronyms or topics" is NOT sufficient.
- "Talks about an adjacent topic" is NOT sufficient.
- "Has a partial answer that doesn't cover the core ask" is NOT sufficient.

# Output
Reply with ONLY a JSON object (no markdown fences, no commentary):
{"chunks": [{"index": 0, "sufficient": true, "relevance": 0.95}], "any_sufficient": true}

index matches the chunk index in the input. relevance is your 0..1 estimate.`;

async function rerank(opts: {
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
        `[Chunk ${i}] ${c.title}${c.section ? ` > ${c.section}` : ""}\n${c.content.slice(0, chunkCharLimit)}`,
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
        // Blend judge relevance with vector similarity, 0.7/0.3 toward judge.
        return [0.7 * j.relevance + 0.3 * c.similarity, c];
      }
      return [c.similarity, c];
    });

    rescored.sort((a, b) => b[0] - a[0]);
    const sorted = rescored.map(([, c]) => c);
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

function chunkCitationUrl(chunk: Chunk): string {
  return chunk.anchor ? `${chunk.url}#${chunk.anchor}` : chunk.url;
}

// ════════════════════════════════════════════════════════════════════
// AGENT — manual tool-use loop with the Anthropic Messages API
// ════════════════════════════════════════════════════════════════════

const AGENT_MODEL = Deno.env.get("ANTHROPIC_AGENT_MODEL") ?? "claude-sonnet-4-6";
const MAX_TURNS = parseInt(Deno.env.get("AGENT_MAX_TURNS") ?? "8", 10);
const RAG_MATCH_COUNT = parseInt(Deno.env.get("RAG_MATCH_COUNT") ?? "8", 10);
const DEFAULT_DOC_FAMILY = Deno.env.get("DEFAULT_DOC_FAMILY") ?? "anthropic-docs";

const TOOLS: Anthropic.Tool[] = [
  {
    name: "search_knowledge_base",
    description:
      "Search the indexed documentation for chunks relevant to a query. " +
      "Returns the top results ranked by semantic relevance, after a hybrid " +
      "vector + LLM-as-judge rerank. Call this BEFORE answering any factual " +
      "question. You can call it up to 3 times per turn with rephrased queries.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language search query." },
        top_k: { type: "integer", description: "Max chunks to return (default 8)." },
      },
      required: ["query"],
    },
  },
  {
    name: "format_citations",
    description:
      "Register the sources you cited so the app can render a Sources panel. " +
      "Call ONCE at the very end of your turn, after your written answer. Returns a " +
      "short acknowledgement — it does NOT produce visible markdown, so do not repeat " +
      "the sources as a list in your written answer.",
    input_schema: {
      type: "object",
      properties: {
        sources: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              url: { type: "string" },
            },
            required: ["url"],
          },
          description: "Array of {title, url} objects to render.",
        },
      },
      required: ["sources"],
    },
  },
];

interface ToolDeps {
  anthropic: Anthropic;
  openai: OpenAI;
  supabase: SupabaseClient;
}

async function runSearchKnowledgeBase(
  input: { query: string; top_k?: number },
  deps: ToolDeps,
): Promise<{ payload: object; chunks: Chunk[] }> {
  const query = input.query;
  const topK = input.top_k ?? RAG_MATCH_COUNT;

  const embedding = await embedQuery(query, deps.openai);
  const raw = await retrieveChunks({
    client: deps.supabase,
    embedding,
    matchCount: topK,
    docFamily: DEFAULT_DOC_FAMILY,
  });
  const { chunks, anySufficient } = await rerank({
    query,
    chunks: raw,
    client: deps.anthropic,
  });

  const payload = {
    query,
    top_k: topK,
    any_sufficient: anySufficient,
    results: chunks.map((c) => ({
      title: c.title,
      section: c.section,
      url: chunkCitationUrl(c),
      similarity: Number(c.similarity.toFixed(3)),
      content: c.content.slice(0, 1800),
    })),
    note: anySufficient
      ? "any_sufficient=true — at least one chunk is on-point. Cite it."
      : "any_sufficient=false — none of the chunks contains a specific answer. Consider clarifying or acknowledging the gap.",
  };

  return { payload, chunks };
}

function runFormatCitations(input: {
  sources: Array<{ title?: string; url: string }>;
}): { payload: string; sources: Array<{ title: string; url: string }> } {
  // Dedupe by URL, preserving order. The result is surfaced to the client
  // via the `sources` SSE event (rendered in the Sources panel) — NOT
  // pasted back into the agent's prose. The tool returns a terse ack so
  // the model knows it succeeded and stops, instead of writing its own
  // (redundant, mis-rendering) "## Sources" markdown block.
  const seen = new Set<string>();
  const deduped: Array<{ title: string; url: string }> = [];
  for (const s of input.sources) {
    const u = (s.url || "").trim();
    if (!u || seen.has(u)) continue;
    seen.add(u);
    deduped.push({ title: (s.title || u).trim(), url: u });
  }
  const payload =
    deduped.length === 0
      ? "No sources registered."
      : `Registered ${deduped.length} source(s). They will appear in the app's Sources panel. Do not list them again in your answer.`;
  return { payload, sources: deduped };
}

type AgentEvent =
  | { kind: "text"; text: string }
  | { kind: "tool_use"; tool: string; input: Record<string, unknown> }
  | { kind: "tool_result"; tool: string }
  | { kind: "done"; sources: Array<{ title: string; url: string }> }
  | { kind: "error"; message: string };

async function* runAgent(opts: {
  question: string;
  history: Anthropic.MessageParam[];
  deps: ToolDeps;
}): AsyncGenerator<AgentEvent> {
  const { question, history, deps } = opts;
  const systemPrompt = buildSystemPrompt();

  const conversation: Anthropic.MessageParam[] = [
    ...history,
    { role: "user", content: question },
  ];

  // Track citation candidates from the search tool so the final Sources
  // block is sourced from real retrieved chunks (not invented).
  const seenSources = new Map<string, { title: string; url: string }>();

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let response: Anthropic.Message;
    try {
      response = await deps.anthropic.messages.create({
        model: AGENT_MODEL,
        max_tokens: 2048,
        system: systemPrompt,
        tools: TOOLS,
        messages: conversation,
      });
    } catch (err) {
      yield {
        kind: "error",
        message: `Anthropic API error: ${(err as Error).message}`,
      };
      return;
    }

    for (const block of response.content) {
      if (block.type === "text" && block.text) {
        yield { kind: "text", text: block.text };
      } else if (block.type === "tool_use") {
        yield {
          kind: "tool_use",
          tool: block.name,
          input: block.input as Record<string, unknown>,
        };
      }
    }

    if (response.stop_reason !== "tool_use") {
      yield { kind: "done", sources: Array.from(seenSources.values()) };
      return;
    }

    conversation.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const toolName = block.name;
      const toolInput = block.input as Record<string, unknown>;

      try {
        if (toolName === "search_knowledge_base") {
          const { payload, chunks } = await runSearchKnowledgeBase(
            toolInput as { query: string; top_k?: number },
            deps,
          );
          for (const c of chunks) {
            const url = chunkCitationUrl(c);
            if (!seenSources.has(url)) {
              seenSources.set(url, { title: c.title, url });
            }
          }
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify(payload, null, 2),
          });
          yield { kind: "tool_result", tool: toolName };
        } else if (toolName === "format_citations") {
          const { payload, sources } = runFormatCitations(
            toolInput as { sources: Array<{ title?: string; url: string }> },
          );
          // The model's declared citations take precedence in the panel —
          // they're the ones it actually used, in the order it used them.
          for (const s of sources) {
            if (!seenSources.has(s.url)) {
              seenSources.set(s.url, { title: s.title, url: s.url });
            }
          }
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: payload,
          });
          yield { kind: "tool_result", tool: toolName };
        } else {
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: `Error: unknown tool "${toolName}"`,
            is_error: true,
          });
        }
      } catch (err) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `Tool execution error: ${(err as Error).message}`,
          is_error: true,
        });
      }
    }

    conversation.push({ role: "user", content: toolResults });
  }

  yield {
    kind: "error",
    message: `Agent stopped after ${MAX_TURNS} turns without a final answer.`,
  };
}

// ════════════════════════════════════════════════════════════════════
// SERVER — SSE entry point
// ════════════════════════════════════════════════════════════════════

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function sse(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function* synthStream(text: string): Generator<string> {
  const parts = text.split(/(\s+)/);
  for (const p of parts) if (p.length > 0) yield p;
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonError(405, "Method not allowed");
  }

  if (!ANTHROPIC_API_KEY) {
    return jsonError(503, "ANTHROPIC_API_KEY not configured (set it in Edge Function secrets).");
  }
  if (!OPENAI_API_KEY) {
    return jsonError(503, "OPENAI_API_KEY not configured (set it in Edge Function secrets).");
  }

  let body: { question?: string; session_id?: string; history?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "Invalid JSON body");
  }

  const question = body?.question?.trim();
  if (!question) return jsonError(400, "Missing 'question'");

  const sessionId = body?.session_id ?? crypto.randomUUID();

  const rawHistory = Array.isArray(body.history) ? body.history : [];
  const history: HistoryItem[] = rawHistory
    .filter(
      (h): h is { role: "user" | "assistant"; content: string } =>
        typeof h === "object" &&
        h !== null &&
        (h as { role?: unknown }).role !== undefined &&
        typeof (h as { content?: unknown }).content === "string",
    )
    .map((h) => ({ role: h.role, content: h.content }));

  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: Record<string, unknown>) =>
        controller.enqueue(encoder.encode(sse(event, data)));

      try {
        send("meta", { session_id: sessionId });

        const intent = await extractIntent({ question, history, client: anthropic });

        // ── Clarify branch
        if (intent.kind === "clarify" && intent.clarifier) {
          const msg = intent.clarifier.message;
          for (const piece of synthStream(msg)) send("token", { token: piece });
          if (intent.clarifier.options?.length) {
            send("clarify_options", { options: intent.clarifier.options });
          }
          send("done", { intent: "clarify" });
          controller.close();
          return;
        }

        // ── Out-of-scope branch
        if (intent.kind === "out_of_scope") {
          const msg =
            "I focus on Anthropic developer documentation — APIs, SDKs, Claude features, and related topics. " +
            "Could you rephrase your question in that context?";
          for (const piece of synthStream(msg)) send("token", { token: piece });
          send("done", { intent: "out_of_scope" });
          controller.close();
          return;
        }

        // ── Answer branch — manual agent loop
        const refinedQuery = intent.refined_query ?? question;
        const conversationHistory: Anthropic.MessageParam[] = history.map((h) => ({
          role: h.role,
          content: h.content,
        }));

        for await (const ev of runAgent({
          question: refinedQuery,
          history: conversationHistory,
          deps: { anthropic, openai, supabase },
        })) {
          if (ev.kind === "text") {
            send("token", { token: ev.text });
          } else if (ev.kind === "tool_use") {
            send("tool_use", { tool: ev.tool, input: ev.input });
          } else if (ev.kind === "tool_result") {
            send("tool_result", { tool: ev.tool });
          } else if (ev.kind === "done") {
            send("sources", { sources: ev.sources });
            send("done", { intent: "answer" });
            controller.close();
            return;
          } else if (ev.kind === "error") {
            send("error", { message: ev.message });
            send("done", { intent: "answer", error: true });
            controller.close();
            return;
          }
        }
      } catch (err) {
        console.error("chat function fatal error:", err);
        send("error", { message: (err as Error).message ?? "Internal error" });
        send("done", { error: true });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      ...corsHeaders,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});
