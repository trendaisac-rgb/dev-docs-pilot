/**
 * Intent classifier — runs before retrieval to decide whether to:
 *   - retrieve + answer
 *   - ask a clarifier
 *   - respond as out-of-scope
 *
 * Uses claude-haiku-4-5 for cheap, fast, structured output (~$0.0001/call).
 * Mirrors the pattern in `supabase/functions/chat/intent.ts` in the Mavryx
 * Helpdesk repo — keeps the agent honest and never-empty.
 */

import Anthropic from "@anthropic-ai/sdk";
import { INTENT_CLASSIFIER_PROMPT } from "./prompts.ts";

export type IntentKind = "answer" | "clarify" | "out_of_scope";

export interface ClarifierPayload {
  message: string;
  options?: string[];
}

export interface IntentResult {
  kind: IntentKind;
  refined_query?: string;
  clarifier?: ClarifierPayload;
}

export interface HistoryItem {
  role: "user" | "assistant";
  content: string;
}

const INTENT_MODEL = Deno.env.get("ANTHROPIC_JUDGE_MODEL") ?? "claude-haiku-4-5";

export async function extractIntent(opts: {
  question: string;
  history: HistoryItem[];
  client: Anthropic;
}): Promise<IntentResult> {
  const { question, history, client } = opts;

  // Only the last 6 turns of history go to the classifier — older context
  // rarely changes the intent and wastes input tokens.
  const messages: Anthropic.MessageParam[] = [
    ...history.slice(-6).map((h) => ({
      role: h.role,
      content: h.content,
    })),
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

    // Strip code fences if the model adds any
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

    // Unknown shape → fail-open
    return { kind: "answer", refined_query: question };
  } catch (err) {
    console.warn("intent extraction failed, falling back to answer:", err);
    return { kind: "answer", refined_query: question };
  }
}
