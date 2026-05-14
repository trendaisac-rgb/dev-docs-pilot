/**
 * Manual agent loop using the Anthropic Messages API with tool_use.
 *
 * Why manual instead of the Claude Agent SDK: the SDK is Python-only at
 * production maturity; in Deno we drive the tool-use loop directly. The
 * shape is identical — assistant emits tool_use → we run the tool →
 * we send back tool_result → repeat until the model stops calling tools.
 *
 * Tools exposed:
 *   - search_knowledge_base(query, top_k): embed + retrieve + rerank
 *   - format_citations(sources):           deterministic Sources block
 */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { SupabaseClient } from "@supabase/supabase-js";

import { buildSystemPrompt } from "./prompts.ts";
import {
  Chunk,
  chunkCitation,
  embedQuery,
  rerank,
  retrieveChunks,
} from "./retrieval.ts";

const AGENT_MODEL = Deno.env.get("ANTHROPIC_AGENT_MODEL") ?? "claude-sonnet-4-6";
const MAX_TURNS = parseInt(Deno.env.get("AGENT_MAX_TURNS") ?? "8", 10);
const RAG_MATCH_COUNT = parseInt(Deno.env.get("RAG_MATCH_COUNT") ?? "8", 10);
const DEFAULT_DOC_FAMILY = Deno.env.get("DEFAULT_DOC_FAMILY") ?? "anthropic-docs";

// ── Tool schemas — these go to the Anthropic API verbatim ──────────

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
        query: {
          type: "string",
          description: "Natural-language search query.",
        },
        top_k: {
          type: "integer",
          description: "Max chunks to return (default 8).",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "format_citations",
    description:
      "Format a list of source references into a clean Sources block in markdown. " +
      "Call this at the end of your answer so the user gets a consistent source list.",
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

// ── Tool runners ─────────────────────────────────────────────────────

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
      url: chunkCitation(c).url,
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
}): { payload: string } {
  const seen = new Set<string>();
  const deduped = input.sources.filter((s) => {
    const u = (s.url || "").trim();
    if (!u || seen.has(u)) return false;
    seen.add(u);
    return true;
  });
  if (deduped.length === 0) return { payload: "## Sources\n\n_(none)_" };

  const lines = ["## Sources", ""];
  deduped.forEach((s, i) => {
    const title = s.title || s.url;
    lines.push(`${i + 1}. [${title}](${s.url})`);
  });
  return { payload: lines.join("\n") };
}

// ── Streaming events surfaced to the caller ──────────────────────────

export type AgentEvent =
  | { kind: "text"; text: string }
  | { kind: "tool_use"; tool: string; input: Record<string, unknown> }
  | { kind: "tool_result"; tool: string }
  | { kind: "done"; sources: Array<{ title: string; url: string }> }
  | { kind: "error"; message: string };

// ── Manual tool-use loop ─────────────────────────────────────────────

export async function* runAgent(opts: {
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

  // Track citation candidates emitted by the search tool, so the final
  // Sources block is sourced from real retrieved chunks (not invented).
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

    // Surface text deltas to the caller (we emit per text block since
    // we're not using true streaming here — simpler + cheaper).
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

    // If the model didn't ask for any tools, we're done.
    if (response.stop_reason !== "tool_use") {
      yield {
        kind: "done",
        sources: Array.from(seenSources.values()),
      };
      return;
    }

    // Append the assistant turn to the conversation as-is.
    conversation.push({ role: "assistant", content: response.content });

    // Execute every tool_use block and collect tool_result blocks.
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
          // Track URLs the agent saw so we can detect invented citations.
          for (const c of chunks) {
            const cit = chunkCitation(c);
            if (!seenSources.has(cit.url)) {
              seenSources.set(cit.url, { title: c.title, url: cit.url });
            }
          }
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify(payload, null, 2),
          });
          yield { kind: "tool_result", tool: toolName };
        } else if (toolName === "format_citations") {
          const { payload } = runFormatCitations(
            toolInput as { sources: Array<{ title?: string; url: string }> },
          );
          // Also add any URLs the model passed (final answer may cite
          // chunks that came in earlier turns).
          const passed = (toolInput as {
            sources?: Array<{ title?: string; url: string }>;
          }).sources ?? [];
          for (const s of passed) {
            if (s.url && !seenSources.has(s.url)) {
              seenSources.set(s.url, { title: s.title ?? s.url, url: s.url });
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

  // Loop exhausted without a final answer.
  yield {
    kind: "error",
    message: `Agent stopped after ${MAX_TURNS} turns without a final answer.`,
  };
}
